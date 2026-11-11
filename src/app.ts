import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { ChangeNotifications } from './change_notifications.js';
import { Store, ApiError, digest, secret } from './store.js';

export interface Config { database: string; origins: string[]; logger?: boolean; eventsWaitMs?: number; rateLimitMax?: number }
const id = z.string().uuid();
const opaque = z.string().min(40).max(2_000_000);
const credentials = z.object({email:z.email().max(254),password:z.string().min(12).max(512),deviceId:id,deviceName:z.string().min(1).max(80)}).strict();
const revision = z.object({id,noteId:z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),parents:z.array(id).max(32),payload:opaque,images:z.array(id).optional()}).strict();
type Identity = { userId: string; deviceId: string; sessionHash: string };

export async function buildApp(config: Config) {
  const app = Fastify({logger:config.logger ? {redact:['req.headers.authorization','req.headers.cookie','body.password']} : false,bodyLimit:4_000_000,trustProxy:false});
  const store = new Store(config.database);
  const db = store.db;
  const changes = new ChangeNotifications();
  app.addHook('preClose', async () => changes.close());
  await app.register(helmet);
  await app.register(cors,{origin:config.origins,credentials:false,methods:['GET','POST','PUT','DELETE'],allowedHeaders:['Authorization','Content-Type']});
  await app.register(rateLimit,{max:config.rateLimitMax ?? 240,timeWindow:'1 minute'});
  app.setErrorHandler((error,request,reply)=> {
    if(error instanceof ZodError) return reply.code(400).send({error:'Invalid request',details:error.issues.map(i=>({path:i.path,message:i.message}))});
    const e=error as Error & {statusCode?:number};
    const status=e.statusCode && e.statusCode>=400 && e.statusCode<500 ? e.statusCode : 500;
    if(status===500) request.log.error({err:e},'Request failed');
    reply.code(status).send({error:status===500?'Internal server error':e.message});
  });
  app.addHook('onClose',async()=>store.close());
  const auth = (authorization?: string): Identity => {
    if(!authorization?.startsWith('Bearer ')) throw new ApiError(401,'Authentication required');
    const sessionHash=digest(authorization.slice(7));
    const row=db.prepare('SELECT s.* FROM sessions s JOIN devices d ON d.id=s.device_id WHERE s.hash=? AND s.expires>? AND d.revoked=0').get(sessionHash,Date.now());
    if(!row) throw new ApiError(401,'Session expired or device revoked');
    return {userId:String(row.user_id),deviceId:String(row.device_id),sessionHash};
  };
  // Wake listeners only after a successful committed write. Chunk transfers do
  // not wake receivers; the finalized note batch does.
  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (reply.statusCode >= 300 || !(
      (req.method === 'PUT' && /^\/v1\/vaults\/[^/]+$/.test(path)) ||
      (req.method === 'POST' && path.endsWith('/batches')) ||
      (req.method === 'DELETE' && (/\/notes\/[^/]+$/.test(path) || /^\/v1\/vaults\/[^/]+$/.test(path)))
    )) return;
    try { changes.publish(auth(req.headers.authorization).userId); } catch { /* revoked */ }
  });
  app.get('/v1/events', async (req, reply) => {
    const who = auth(req.headers.authorization);
    const query = z.object({since:z.string().max(100).optional()}).strict().parse(req.query);
    const abort = new AbortController();
    const closed = () => abort.abort();
    reply.raw.on('close', closed);
    try {
      if (query.since) await changes.wait(who.userId, query.since, config.eventsWaitMs ?? 15000, abort.signal);
      // A device can be revoked while its request is waiting.
      auth(req.headers.authorization);
      return {cursor:changes.cursor(who.userId)};
    } finally { reply.raw.off('close', closed); }
  });
  const ownVault=(vaultId:string,userId:string)=> {
    const retired=db.prepare('SELECT user_id FROM purged_vaults WHERE id=?').get(vaultId);
    if(retired) throw new ApiError(retired.user_id===userId?410:404,retired.user_id===userId?'vault_deleted':'Vault not found');
    const row=db.prepare('SELECT * FROM vaults WHERE id=? AND user_id=?').get(vaultId,userId);
    if(!row) throw new ApiError(404,'Vault not found');
    return row;
  };
  const createSession=(userId:string,deviceId:string,deviceName:string)=>store.transaction(()=> {
    const device=db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    if(device && (device.user_id!==userId || device.revoked)) throw new ApiError(403,'Device unavailable; use a new device identity');
    db.prepare('INSERT OR IGNORE INTO devices(id,user_id,name,created_at) VALUES(?,?,?,?)').run(deviceId,userId,deviceName,new Date().toISOString());
    const token=secret();
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),userId,deviceId,Date.now()+30*86400_000);
    const user=db.prepare('SELECT envelope FROM users WHERE id=?').get(userId)!;
    return {token,userId,deviceId,accountEnvelope:user.envelope??null,expiresIn:30*86400};
  });
  app.get('/health',async()=>({status:'ok',protocol:1}));
  app.get('/.well-known/silique',async()=>({name:'Silique',api_version:'1',registration:'first-user',features:{e2ee:true,multi_vault:true,device_pairing:true,recovery:true,revision_dag:true,image_attachments:true,change_notifications:true,vault_deletion:true},limits:{batch:100,payload:2_000_000}}));
  app.post('/v1/auth/register',{config:{rateLimit:{max:config.rateLimitMax ?? 5,timeWindow:'1 minute'}}},async(req,reply)=> {
    const data=credentials.parse(req.body);
    // createUser enforces the single-user limit inside a transaction: the
    // first account is created, any further attempt is rejected with 403.
    const userId=await store.createUser(data.email,data.password);
    return reply.code(201).send(createSession(userId,data.deviceId,data.deviceName));
  });
  app.post('/v1/auth/login',{config:{rateLimit:{max:config.rateLimitMax ?? 8,timeWindow:'1 minute'}}},async(req)=> {
    const data=credentials.parse(req.body);
    const user=await store.verifyPassword(data.email,data.password);
    return createSession(String(user.id),data.deviceId,data.deviceName);
  });
  app.post('/v1/auth/logout',async(req,reply)=> {
    const identity=auth(req.headers.authorization);
    db.prepare('DELETE FROM sessions WHERE hash=?').run(identity.sessionHash);
    return reply.code(204).send();
  });
  app.get('/v1/account',async(req)=> {
    const who=auth(req.headers.authorization);
    const row=db.prepare('SELECT id,email,envelope FROM users WHERE id=?').get(who.userId)!;
    return {id:row.id,email:row.email,accountEnvelope:row.envelope};
  });
  app.put('/v1/account/envelope',async(req)=> {
    const who=auth(req.headers.authorization);
    const data=z.object({envelope:opaque,expected:z.string().nullable()}).strict().parse(req.body);
    const result=db.prepare('UPDATE users SET envelope=? WHERE id=? AND envelope IS ?').run(data.envelope,who.userId,data.expected);
    if(!result.changes) throw new ApiError(409,'Account keys changed; reload before retrying');
    return {ok:true};
  });
  app.get('/v1/devices',async(req)=> {
    const who=auth(req.headers.authorization);
    return {devices:db.prepare('SELECT id,name,revoked,created_at FROM devices WHERE user_id=? ORDER BY created_at').all(who.userId)};
  });
  const publicKey=z.string().length(44).regex(/^[A-Za-z0-9+/]{43}=$/);
  app.post('/v1/pairings',async(req,reply)=> {
    const who=auth(req.headers.authorization);const data=z.object({publicKey}).strict().parse(req.body);
    const pairingId=randomUUID();
    store.transaction(()=> {
      db.prepare('DELETE FROM pairings WHERE expires<? OR (user_id=? AND requester_id=?)').run(Date.now(),who.userId,who.deviceId);
      db.prepare('INSERT INTO pairings(id,user_id,requester_id,requester_key,expires) VALUES(?,?,?,?,?)').run(pairingId,who.userId,who.deviceId,data.publicKey,Date.now()+10*60_000);
    });
    return reply.code(201).send({id:pairingId});
  });
  app.get('/v1/pairings',async(req)=> {
    const who=auth(req.headers.authorization);
    return {pairings:db.prepare('SELECT id,requester_id AS requesterId,requester_key AS requesterKey,approver_id AS approverId,approver_key AS approverKey,envelope,expires FROM pairings WHERE user_id=? AND expires>? ORDER BY expires').all(who.userId,Date.now())};
  });
  app.post('/v1/pairings/:id/offer',async(req)=> {
    const who=auth(req.headers.authorization);const pairingId=id.parse((req.params as {id:string}).id);const data=z.object({publicKey}).strict().parse(req.body);
    const result=db.prepare('UPDATE pairings SET approver_id=?,approver_key=? WHERE id=? AND user_id=? AND requester_id!=? AND approver_id IS NULL AND expires>?').run(who.deviceId,data.publicKey,pairingId,who.userId,who.deviceId,Date.now());
    if(!result.changes) throw new ApiError(409,'Pairing unavailable or already offered');
    return {ok:true};
  });
  app.post('/v1/pairings/:id/approve',async(req)=> {
    const who=auth(req.headers.authorization);const pairingId=id.parse((req.params as {id:string}).id);const data=z.object({envelope:opaque}).strict().parse(req.body);
    const result=db.prepare('UPDATE pairings SET envelope=? WHERE id=? AND user_id=? AND approver_id=? AND envelope IS NULL AND expires>?').run(data.envelope,pairingId,who.userId,who.deviceId,Date.now());
    if(!result.changes) throw new ApiError(409,'Pairing unavailable or already approved');
    return {ok:true};
  });
  app.put('/v1/devices/:id/name',async(req)=> {
    const who=auth(req.headers.authorization);
    const deviceId=id.parse((req.params as {id:string}).id);
    const data=z.object({name:z.string().trim().min(1).max(80)}).strict().parse(req.body);
    // Owner- and non-revoked-scoped: another account's device looks like a
    // missing one, so names cannot be probed or changed across accounts.
    const changed=db.prepare('UPDATE devices SET name=? WHERE id=? AND user_id=? AND revoked=0').run(data.name,deviceId,who.userId);
    if(!changed.changes) throw new ApiError(404,'Device not found');
    return {ok:true,name:data.name};
  });
  app.delete('/v1/devices/:id',async(req,reply)=> {
    const who=auth(req.headers.authorization); const deviceId=id.parse((req.params as {id:string}).id);
    store.transaction(()=> {
      const changed=db.prepare('UPDATE devices SET revoked=1 WHERE id=? AND user_id=?').run(deviceId,who.userId);
      if(!changed.changes) throw new ApiError(404,'Device not found');
      db.prepare('DELETE FROM sessions WHERE device_id=?').run(deviceId);
    });
    return reply.code(204).send();
  });
  app.get('/v1/vaults',async(req)=> {
    const who=auth(req.headers.authorization);
    return {vaults:db.prepare('SELECT id,key_wrap AS keyWrap,metadata,version FROM vaults WHERE user_id=? ORDER BY id').all(who.userId),deletedVaults:db.prepare('SELECT id FROM purged_vaults WHERE user_id=? ORDER BY id').all(who.userId).map(row=>row.id)};
  });
  app.delete('/v1/vaults/:id',async(req)=> {
    const who=auth(req.headers.authorization),vaultId=id.parse((req.params as {id:string}).id);
    const data=z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(req.body);
    return store.transaction(()=> {
      const retired=db.prepare('SELECT user_id FROM purged_vaults WHERE id=?').get(vaultId);
      if(retired) {
        if(retired.user_id!==who.userId) throw new ApiError(404,'Vault not found');
        return {deleted:true,vaultId};
      }
      const vault=ownVault(vaultId,who.userId);
      if(vault.version!==data.expectedVersion) throw new ApiError(409,'Vault keys changed; reload before retrying');
      db.prepare('INSERT INTO purged_vaults(id,user_id,deleted_at) VALUES(?,?,?)').run(vaultId,who.userId,new Date().toISOString());
      db.prepare('DELETE FROM batches WHERE user_id=? AND id IN (SELECT batch_id FROM vault_batch_receipts WHERE user_id=? AND vault_id=?)').run(who.userId,who.userId,vaultId);
      db.prepare('DELETE FROM heads WHERE vault_id=?').run(vaultId);
      db.prepare('DELETE FROM revisions WHERE vault_id=?').run(vaultId);
      db.prepare('DELETE FROM purged_notes WHERE vault_id=?').run(vaultId);
      db.prepare('DELETE FROM image_assets WHERE vault_id=?').run(vaultId);
      db.prepare('DELETE FROM vaults WHERE id=?').run(vaultId);
      return {deleted:true,vaultId};
    });
  });
  app.put('/v1/vaults/:id',async(req,reply)=> {
    const who=auth(req.headers.authorization);const vaultId=id.parse((req.params as {id:string}).id);
    const data=z.object({keyWrap:opaque,metadata:opaque,expectedVersion:z.number().int().nonnegative()}).strict().parse(req.body);
    return store.transaction(()=> {
      const retired=db.prepare('SELECT user_id FROM purged_vaults WHERE id=?').get(vaultId);
      if(retired) throw new ApiError(retired.user_id===who.userId?410:404,retired.user_id===who.userId?'vault_deleted':'Vault not found');
      const existing=db.prepare('SELECT * FROM vaults WHERE id=?').get(vaultId);
      if(existing && existing.user_id!==who.userId) throw new ApiError(404,'Vault not found');
      if(Number(existing?.version??0)!==data.expectedVersion) throw new ApiError(409,'Vault keys changed; reload before retrying');
      const version=data.expectedVersion+1;
      if(existing) db.prepare('UPDATE vaults SET key_wrap=?,metadata=?,version=? WHERE id=?').run(data.keyWrap,data.metadata,version,vaultId);
      else db.prepare('INSERT INTO vaults(id,user_id,key_wrap,metadata) VALUES(?,?,?,?)').run(vaultId,who.userId,data.keyWrap,data.metadata);
      reply.code(existing?200:201);return {version};
    });
  });
  const imageParams=z.object({id,assetId:id,index:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()});
  const imageNoteId=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
  app.put('/v1/vaults/:id/images/:assetId/chunks/:index',async(req)=> {
    const who=auth(req.headers.authorization),params=imageParams.parse(req.params);
    ownVault(params.id,who.userId);
    const data=z.object({noteId:imageNoteId,payload:opaque}).strict().parse(req.body);
    return store.transaction(()=> {
      if(db.prepare('SELECT 1 FROM purged_notes WHERE vault_id=? AND note_id=?').get(params.id,data.noteId)) return {purged:true};
      const existing=db.prepare('SELECT * FROM image_assets WHERE vault_id=? AND id=?').get(params.id,params.assetId);
      if(existing && existing.note_id!==data.noteId) throw new ApiError(409,'Image identity collision');
      const chunk=db.prepare('SELECT payload FROM image_chunks WHERE vault_id=? AND asset_id=? AND chunk_index=?').get(params.id,params.assetId,params.index!);
      if(chunk) { if(chunk.payload!==data.payload) throw new ApiError(409,'Image chunks are immutable');return {ok:true}; }
      if(existing?.manifest) throw new ApiError(409,'Image already finalized');
      db.prepare('INSERT OR IGNORE INTO image_assets(vault_id,note_id,id) VALUES(?,?,?)').run(params.id,data.noteId,params.assetId);
      db.prepare('INSERT INTO image_chunks VALUES(?,?,?,?)').run(params.id,params.assetId,params.index!,data.payload);
      return {ok:true};
    });
  });
  app.put('/v1/vaults/:id/images/:assetId',async(req)=> {
    const who=auth(req.headers.authorization),params=imageParams.parse(req.params);
    ownVault(params.id,who.userId);
    const data=z.object({noteId:imageNoteId,manifest:opaque,chunkCount:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).strict().parse(req.body);
    return store.transaction(()=> {
      if(db.prepare('SELECT 1 FROM purged_notes WHERE vault_id=? AND note_id=?').get(params.id,data.noteId)) return {purged:true};
      const existing=db.prepare('SELECT * FROM image_assets WHERE vault_id=? AND id=?').get(params.id,params.assetId);
      if(!existing || existing.note_id!==data.noteId) throw new ApiError(409,'Image chunks missing or identity mismatch');
      if(existing.manifest) {
        if(existing.manifest!==data.manifest || existing.chunk_count!==data.chunkCount) throw new ApiError(409,'Image manifest is immutable');
        return {ok:true};
      }
      const chunks=db.prepare('SELECT COUNT(*) AS n,MIN(chunk_index) AS first,MAX(chunk_index) AS last FROM image_chunks WHERE vault_id=? AND asset_id=?').get(params.id,params.assetId)!;
      if(chunks.n!==data.chunkCount || chunks.first!==0 || chunks.last!==data.chunkCount-1) throw new ApiError(409,'Image chunks incomplete');
      db.prepare('UPDATE image_assets SET manifest=?,chunk_count=? WHERE vault_id=? AND id=?').run(data.manifest,data.chunkCount,params.id,params.assetId);
      return {ok:true};
    });
  });
  app.get('/v1/vaults/:id/images/:assetId',async(req)=> {
    const who=auth(req.headers.authorization),params=imageParams.parse(req.params);
    ownVault(params.id,who.userId);
    const asset=db.prepare('SELECT note_id AS noteId,manifest,chunk_count AS chunkCount FROM image_assets WHERE vault_id=? AND id=? AND manifest IS NOT NULL').get(params.id,params.assetId);
    if(!asset) throw new ApiError(404,'Image not found');
    return asset;
  });
  app.get('/v1/vaults/:id/images/:assetId/chunks/:index',async(req)=> {
    const who=auth(req.headers.authorization),params=imageParams.parse(req.params);
    ownVault(params.id,who.userId);
    const chunk=db.prepare('SELECT c.payload FROM image_chunks c JOIN image_assets a ON a.vault_id=c.vault_id AND a.id=c.asset_id WHERE c.vault_id=? AND c.asset_id=? AND c.chunk_index=? AND a.manifest IS NOT NULL').get(params.id,params.assetId,params.index!);
    if(!chunk) throw new ApiError(404,'Image chunk not found');
    return chunk;
  });
  app.delete('/v1/vaults/:id/notes/:noteId',async(req)=> {
    const who=auth(req.headers.authorization);
    const params=req.params as {id:string,noteId:string};
    const vaultId=id.parse(params.id),noteId=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).parse(params.noteId);
    ownVault(vaultId,who.userId);
    return store.transaction(()=> {
      db.prepare('INSERT OR IGNORE INTO purged_notes VALUES(?,?)').run(vaultId,noteId);
      const images=db.prepare('SELECT id FROM image_assets WHERE vault_id=? AND (note_id=? OR id IN (SELECT asset_id FROM image_refs WHERE vault_id=? AND note_id=?))').all(vaultId,noteId,vaultId,noteId);
      db.prepare('DELETE FROM image_refs WHERE vault_id=? AND note_id=?').run(vaultId,noteId);
      for(const image of images) db.prepare('DELETE FROM image_assets WHERE vault_id=? AND id=? AND NOT EXISTS (SELECT 1 FROM image_refs WHERE vault_id=? AND asset_id=?)').run(vaultId,String(image.id),vaultId,String(image.id));
      db.prepare('DELETE FROM heads WHERE vault_id=? AND note_id=?').run(vaultId,noteId);
      db.prepare('DELETE FROM revisions WHERE vault_id=? AND note_id=?').run(vaultId,noteId);
      return {purged:true};
    });
  });
  app.get('/v1/vaults/:id/changes',async(req)=> {
    const who=auth(req.headers.authorization); const vaultId=id.parse((req.params as {id:string}).id);ownVault(vaultId,who.userId);
    const query=z.object({cursor:z.coerce.number().int().nonnegative().default(0),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict().parse(req.query);
    const rows=db.prepare('SELECT seq,id,note_id AS noteId,parents,payload,device_id AS deviceId FROM revisions WHERE vault_id=? AND seq>? ORDER BY seq LIMIT ?').all(vaultId,query.cursor,query.limit+1);
    const page=rows.slice(0,query.limit).map(row=>({...row,parents:JSON.parse(String(row.parents)) as string[]}));
    return {purged:db.prepare('SELECT note_id FROM purged_notes WHERE vault_id=?').all(vaultId).map(row=>row.note_id),revisions:page,cursor:rows[Math.min(rows.length,query.limit)-1]?.seq??query.cursor,hasMore:rows.length>query.limit};
  });
  app.post('/v1/vaults/:id/batches',async(req)=> {
    const who=auth(req.headers.authorization);const vaultId=id.parse((req.params as {id:string}).id);ownVault(vaultId,who.userId);
    const data=z.object({batchId:id,revisions:z.array(revision).min(1).max(100)}).strict().parse(req.body);
    if(data.revisions.some(r=>new Set(r.parents).size!==r.parents.length)) throw new ApiError(400,'Duplicate parents');
    const hash=digest(JSON.stringify({vaultId,...data}));
    return store.transaction(()=> {
      const previous=db.prepare('SELECT * FROM batches WHERE user_id=? AND id=?').get(who.userId,data.batchId);
      if(previous) { if(previous.hash!==hash) throw new ApiError(409,'Batch ID already used for another request');return JSON.parse(String(previous.response)); }
      for(const rev of data.revisions) {
        if(db.prepare('SELECT 1 FROM purged_notes WHERE vault_id=? AND note_id=?').get(vaultId,rev.noteId)) continue;
        const exists=db.prepare('SELECT * FROM revisions WHERE id=?').get(rev.id);
        if(exists) {
          if(exists.vault_id!==vaultId || exists.note_id!==rev.noteId || exists.parents!==JSON.stringify(rev.parents) || exists.payload!==rev.payload) throw new ApiError(409,'Revision ID collision');
          continue;
        }
        for(const parent of rev.parents) {
          if(!db.prepare('SELECT id FROM revisions WHERE id=? AND vault_id=? AND note_id=?').get(parent,vaultId,rev.noteId)) throw new ApiError(409,'Parent revision missing');
        }
        for(const imageId of rev.images??[]) {
          if(!db.prepare('SELECT 1 FROM image_assets WHERE vault_id=? AND id=? AND manifest IS NOT NULL').get(vaultId,imageId)) throw new ApiError(409,'Image not uploaded yet');
          db.prepare('INSERT OR IGNORE INTO image_refs VALUES(?,?,?)').run(vaultId,imageId,rev.noteId);
        }
        db.prepare('INSERT INTO revisions(id,vault_id,note_id,parents,payload,device_id,created_at) VALUES(?,?,?,?,?,?,?)').run(rev.id,vaultId,rev.noteId,JSON.stringify(rev.parents),rev.payload,who.deviceId,new Date().toISOString());
        for(const parent of rev.parents) db.prepare('DELETE FROM heads WHERE vault_id=? AND note_id=? AND revision_id=?').run(vaultId,rev.noteId,parent);
        db.prepare('INSERT INTO heads VALUES(?,?,?)').run(vaultId,rev.noteId,rev.id);
      }
      const response={accepted:data.revisions.map(r=>r.id),batchId:data.batchId};
      db.prepare('INSERT INTO batches(user_id,id,hash,response) VALUES(?,?,?,?)').run(who.userId,data.batchId,hash,JSON.stringify(response));
      db.prepare('INSERT INTO vault_batch_receipts(user_id,batch_id,vault_id) VALUES(?,?,?)').run(who.userId,data.batchId,vaultId);
      return response;
    });
  });
  return {app,store};
}
