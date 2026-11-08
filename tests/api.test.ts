import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

const opaque='encrypted:'.padEnd(100,'x');
const password='a long test password 12345';
async function fixture(database=':memory:', eventsWaitMs?: number) {
  const {app,store}=await buildApp({database,origins:[],eventsWaitMs});
  const register=async(email:string)=> {
    const deviceId=randomUUID();
    const response=await app.inject({method:'POST',url:'/v1/auth/register',payload:{email,password,deviceId,deviceName:'test'}});
    assert.equal(response.statusCode,201,response.body);
    return {...response.json(),deviceId,headers:{authorization:`Bearer ${response.json().token}`}};
  };
  return {app,store,register};
}
test('discovery advertises first-user registration and auth is fail closed',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  assert.equal((await f.app.inject('/.well-known/silique')).json().registration,'first-user');
  assert.equal((await f.app.inject('/.well-known/silique')).json().name,'Silique');
  assert.equal((await f.app.inject('/v1/vaults')).statusCode,401);
});
test('first account registers, second account is rejected as single-user, login works',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  const first=await f.register('one@example.com');
  assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/register',payload:{email:'two@example.com',password,deviceId:randomUUID(),deviceName:'test'}})).statusCode,403);
  const body=await f.app.inject({method:'POST',url:'/v1/auth/register',payload:{email:'two@example.com',password,deviceId:randomUUID(),deviceName:'test'}});
  assert.match(body.json().error,/single-user/);
  const login=await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'one@example.com',password,deviceId:randomUUID(),deviceName:'test'}});
  assert.equal(login.statusCode,200);
  assert.equal((await f.app.inject({url:'/v1/account',headers:{authorization:`Bearer ${login.json().token}`}})).json().email,'one@example.com');
});
test('registration rejects extra plaintext fields',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/register',payload:{email:'plain@example.com',password,deviceId:randomUUID(),deviceName:'test',masterKey:'secret'}})).statusCode,400);
});
test('single-user: devices of the one account share vaults; unauthenticated requests are rejected',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  const a=await f.register('a@example.com'); const vault=randomUUID();
  const payload={keyWrap:opaque,metadata:opaque,expectedVersion:0};
  assert.equal((await f.app.inject({method:'PUT',url:`/v1/vaults/${vault}`,headers:a.headers,payload})).statusCode,201);
  // A second device of the same account is logged in, not registered.
  const login=await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'a@example.com',password,deviceId:randomUUID(),deviceName:'second'}});
  assert.equal(login.statusCode,200);
  const b={headers:{authorization:`Bearer ${login.json().token}`}};
  // Same account: the second device sees the account's vault.
  assert.deepEqual((await f.app.inject({url:'/v1/vaults',headers:b.headers})).json().vaults.map((v:{id:string})=>v.id),[vault]);
  // Unauthenticated requests are rejected.
  assert.equal((await f.app.inject({url:'/v1/vaults'})).statusCode,401);
  assert.equal((await f.app.inject({url:`/v1/vaults/${vault}/changes`})).statusCode,401);
  // A second account cannot be created.
  assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/register',payload:{email:'b@example.com',password,deviceId:randomUUID(),deviceName:'test'}})).statusCode,403);
  assert.equal((await f.app.inject({method:'PUT',url:`/v1/vaults/${vault}`,headers:a.headers,payload})).statusCode,409);
});
test('lost acknowledgement replay, branching, merge parents and atomic rollback',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());const a=await f.register('sync@example.com');const vault=randomUUID();
  await f.app.inject({method:'PUT',url:`/v1/vaults/${vault}`,headers:a.headers,payload:{keyWrap:opaque,metadata:opaque,expectedVersion:0}});
  const push=(payload:object)=>f.app.inject({method:'POST',url:`/v1/vaults/${vault}/batches`,headers:a.headers,payload});
  const root={id:randomUUID(),noteId:'note',parents:[] as string[],payload:opaque};
  const batch={batchId:randomUUID(),revisions:[root]};
  const first=await push(batch),replay=await push(batch);
  assert.equal(first.statusCode,200);assert.deepEqual(first.json(),replay.json());
  assert.equal((await push({...batch,revisions:[{...root,payload:opaque+'changed'}]})).statusCode,409);
  const left={...root,id:randomUUID(),parents:[root.id]},right={...root,id:randomUUID(),parents:[root.id]};
  assert.equal((await push({batchId:randomUUID(),revisions:[left,right]})).statusCode,200);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM heads').get()!.n,2);
  const missing={...root,id:randomUUID(),parents:[randomUUID()]};
  assert.equal((await push({batchId:randomUUID(),revisions:[{...root,id:randomUUID()},missing]})).statusCode,409);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()!.n,3);
  const merge={...root,id:randomUUID(),parents:[left.id,right.id]};
  assert.equal((await push({batchId:randomUUID(),revisions:[merge]})).statusCode,200);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM heads').get()!.n,1);
  const page=await f.app.inject({url:`/v1/vaults/${vault}/changes?limit=2`,headers:a.headers});
  assert.equal(page.json().hasMore,true);assert.equal(page.json().revisions.length,2);
  assert.equal((await f.app.inject({url:`/v1/vaults/${vault}/changes?cursor=${page.json().cursor}`,headers:a.headers})).json().revisions.length,2);
});
test('revocation invalidates sessions and cannot be bypassed by login',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());const a=await f.register('device@example.com');
  assert.equal((await f.app.inject({method:'DELETE',url:`/v1/devices/${a.deviceId}`,headers:a.headers})).statusCode,204);
  assert.equal((await f.app.inject({url:'/v1/account',headers:a.headers})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'device@example.com',password,deviceId:a.deviceId,deviceName:'test'}})).statusCode,403);
});
test('account key initialization uses compare and swap; login never returns a plaintext key',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());const a=await f.register('key@example.com');
  assert.equal(a.accountEnvelope,null);
  const put=()=>f.app.inject({method:'PUT',url:'/v1/account/envelope',headers:a.headers,payload:{envelope:opaque,expected:null}});
  assert.equal((await put()).statusCode,200);assert.equal((await put()).statusCode,409);
  assert.equal((await f.app.inject({url:'/v1/account',headers:a.headers})).json().accountEnvelope,opaque);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'key@example.com',password:'wrong password 12345',deviceId:randomUUID(),deviceName:'test'}})).statusCode,401);
});
test('persistent state survives a server restart',async()=> {
  const dir=mkdtempSync(join(tmpdir(),'silique-server-'));const path=join(dir,'silique.sqlite');
  try {
    const f=await fixture(path);const a=await f.register('restart@example.com');await f.app.close();
    const g=await fixture(path);
    assert.equal((await g.app.inject({url:'/v1/account',headers:a.headers})).json().email,'restart@example.com');
    await g.app.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('pairing offers and approvals are scoped to the account and offering device',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());const a=await f.register('pair@example.com');
  const next=await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'pair@example.com',password,deviceId:randomUUID(),deviceName:'new'}});
  const headers={authorization:`Bearer ${next.json().token}`};
  const publicKey=Buffer.alloc(32,1).toString('base64');
  const pending=await f.app.inject({method:'POST',url:'/v1/pairings',headers,payload:{publicKey}});assert.equal(pending.statusCode,201);
  const id=pending.json().id;
  assert.equal((await f.app.inject({url:'/v1/pairings'})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:`/v1/pairings/${id}/offer`,payload:{publicKey}})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:`/v1/pairings/${id}/offer`,headers,payload:{publicKey}})).statusCode,409);
  assert.equal((await f.app.inject({method:'POST',url:`/v1/pairings/${id}/offer`,headers:a.headers,payload:{publicKey}})).statusCode,200);
  assert.equal((await f.app.inject({method:'POST',url:`/v1/pairings/${id}/approve`,headers,payload:{envelope:opaque}})).statusCode,409);
  assert.equal((await f.app.inject({method:'POST',url:`/v1/pairings/${id}/approve`,headers:a.headers,payload:{envelope:opaque}})).statusCode,200);
  const pair=(await f.app.inject({url:'/v1/pairings',headers})).json().pairings[0];assert.equal(pair.envelope,opaque);
});

test('permanent deletion erases payloads, propagates to all cursors and prevents resurrection',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  const a=await f.register('purge@example.com');
  const vault=randomUUID(),noteId=randomUUID();
  await f.app.inject({method:'PUT',url:`/v1/vaults/${vault}`,headers:a.headers,payload:{keyWrap:opaque,metadata:opaque,expectedVersion:0}});
  const root={id:randomUUID(),noteId,parents:[],payload:opaque};
  const push=(revisions:object[])=>f.app.inject({method:'POST',url:`/v1/vaults/${vault}/batches`,headers:a.headers,payload:{batchId:randomUUID(),revisions}});
  await push([root]);
  const url=`/v1/vaults/${vault}/notes/${noteId}`;
  assert.equal((await f.app.inject({method:'DELETE',url})).statusCode,401);
  assert.equal((await f.app.inject({method:'DELETE',url,headers:a.headers})).statusCode,200);
  assert.equal((await f.app.inject({method:'DELETE',url,headers:a.headers})).statusCode,200);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE note_id=?').get(noteId)!.n,0);
  assert.equal((await push([{...root,id:randomUUID(),parents:[root.id]}])).statusCode,200);
  const page=(await f.app.inject({url:`/v1/vaults/${vault}/changes?cursor=999`,headers:a.headers})).json();
  assert.deepEqual(page.purged,[noteId]);assert.deepEqual(page.revisions,[]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE note_id=?').get(noteId)!.n,0);
});

test('encrypted image chunks are isolated, immutable, resumable and deleted after the last note is purged',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  const a=await f.register('images@example.com');
  const vault=randomUUID(),asset=randomUUID(),note=randomUUID(),copy=randomUUID();
  await f.app.inject({method:'PUT',url:`/v1/vaults/${vault}`,headers:a.headers,payload:{keyWrap:opaque,metadata:opaque,expectedVersion:0}});
  const base=`/v1/vaults/${vault}/images/${asset}`;
  const chunk0='encrypted-image-0:'.padEnd(900000,'a'),chunk1='encrypted-image-1:'.padEnd(500000,'b');
  const put=(suffix:string,payload:object)=>f.app.inject({method:'PUT',url:base+suffix,headers:a.headers,payload});
  assert.equal((await put('/chunks/0',{noteId:note,payload:chunk0})).statusCode,200);
  assert.equal((await put('/chunks/0',{noteId:note,payload:chunk0})).statusCode,200);
  assert.equal((await put('/chunks/0',{noteId:note,payload:chunk1})).statusCode,409);
  assert.equal((await f.app.inject({url:base,headers:a.headers})).statusCode,404);
  assert.equal((await put('',{noteId:note,manifest:opaque,chunkCount:2})).statusCode,409);
  assert.equal((await put('/chunks/1',{noteId:note,payload:chunk1})).statusCode,200);
  assert.equal((await put('',{noteId:note,manifest:opaque,chunkCount:2})).statusCode,200);
  assert.equal((await put('',{noteId:note,manifest:opaque,chunkCount:2})).statusCode,200);
  assert.equal((await put('',{noteId:note,manifest:opaque+'changed',chunkCount:2})).statusCode,409);
  for(const suffix of ['', '/chunks/0']) {
    assert.equal((await f.app.inject({url:base+suffix})).statusCode,401);
    assert.equal((await f.app.inject({method:'PUT',url:base+suffix,payload:suffix?{noteId:note,payload:chunk0}:{noteId:note,manifest:opaque,chunkCount:2}})).statusCode,401);
  }
  assert.equal((await f.app.inject({url:base+'/chunks/0',headers:a.headers})).json().payload,chunk0);
  assert.equal((await f.app.inject({url:base+'/chunks/99',headers:a.headers})).statusCode,404);
  assert.equal((await put('/chunks/2',{noteId:note,payload:chunk1})).statusCode,409);
  const revisions=[{id:randomUUID(),noteId:copy,parents:[],payload:opaque,images:[asset]}];
  assert.equal((await f.app.inject({method:'POST',url:`/v1/vaults/${vault}/batches`,headers:a.headers,payload:{batchId:randomUUID(),revisions}})).statusCode,200);
  const purge=(id:string)=>f.app.inject({method:'DELETE',url:`/v1/vaults/${vault}/notes/${id}`,headers:a.headers});
  await purge(note);
  assert.equal((await f.app.inject({url:base,headers:a.headers})).statusCode,200);
  await purge(copy);
  assert.equal((await f.app.inject({url:base,headers:a.headers})).statusCode,404);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM image_chunks').get()!.n,0);
  assert.deepEqual((await put('/chunks/0',{noteId:note,payload:chunk0})).json(),{purged:true});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM image_assets').get()!.n,0);
});

test('device names are renamed by the server with validation and isolation',async(t)=> {
  const f=await fixture();t.after(()=>f.app.close());
  const a=await f.register('rename@example.com');
  const rename=(headers:{authorization:string}|undefined,deviceId:string,name:string)=>f.app.inject({method:'PUT',url:`/v1/devices/${deviceId}/name`,headers,payload:{name}});
  const trimmed=await rename(a.headers,a.deviceId,'  Laptop Kamila  ');
  assert.equal(trimmed.statusCode,200);
  assert.equal(trimmed.json().name,'Laptop Kamila');
  assert.equal((await rename(undefined,a.deviceId,'Przejęte')).statusCode,401);
  assert.equal((await rename(a.headers,randomUUID(),'Obce')).statusCode,404);
  assert.equal((await rename(a.headers,a.deviceId,'   ')).statusCode,400);
  assert.equal((await rename(a.headers,a.deviceId,'x'.repeat(81))).statusCode,400);
  assert.equal((await rename(a.headers,a.deviceId,'x'.repeat(80))).statusCode,200);
  const listed=(await f.app.inject({url:'/v1/devices',headers:a.headers})).json().devices;
  assert.equal(listed.find((d:{id:string})=>d.id===a.deviceId).name,'x'.repeat(80));
  // A later login presents a constant product name and must not reset it.
  const login=await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'rename@example.com',password,deviceId:a.deviceId,deviceName:'Silique'}});
  assert.equal(login.statusCode,200);
  const headers={authorization:`Bearer ${login.json().token}`};
  const afterLogin=(await f.app.inject({url:'/v1/devices',headers})).json().devices;
  assert.equal(afterLogin.find((d:{id:string})=>d.id===a.deviceId).name,'x'.repeat(80));
  assert.equal((await rename(headers,a.deviceId,'Nowa nazwa')).json().name,'Nowa nazwa');
  // A revoked device cannot be renamed even by its owner.
  const second=await f.app.inject({method:'POST',url:'/v1/auth/login',payload:{email:'rename@example.com',password,deviceId:randomUUID(),deviceName:'drugie'}});
  const secondId=second.json().deviceId;
  assert.equal((await f.app.inject({method:'DELETE',url:`/v1/devices/${secondId}`,headers:a.headers})).statusCode,204);
  assert.equal((await rename(a.headers,secondId,'Po cofnięciu')).statusCode,404);
});

test('foreground change notifications wake after writes, time out without changes, and recheck auth', async(t) => {
  const f = await fixture(':memory:', 200);
  t.after(() => f.app.close());
  const a = await f.register('events-a@example.com');
  const first = await f.app.inject({url:'/v1/events', headers:a.headers});
  const cursor = first.json().cursor;
  assert.equal(first.statusCode, 200);
  assert.equal((await f.app.inject('/v1/events')).statusCode, 401);

  // With no new write, a wait times out and observes the same cursor.
  const quiet = await f.app.inject({url:`/v1/events?since=${cursor}`, headers:a.headers});
  assert.equal(quiet.statusCode, 200);
  assert.equal(quiet.json().cursor, cursor);

  // A write in the account's own vault wakes the pending wait.
  const pending = f.app.inject({url:`/v1/events?since=${cursor}`, headers:a.headers}).then(response => response);
  await new Promise(resolve => setTimeout(resolve, 20));
  const vault = randomUUID();
  await f.app.inject({method:'PUT', url:`/v1/vaults/${vault}`, headers:a.headers, payload:{keyWrap:opaque, metadata:opaque, expectedVersion:0}});
  const notified = await pending;
  assert.equal(notified.statusCode, 200);
  assert.notEqual(notified.json().cursor, cursor);
  assert.deepEqual(Object.keys(notified.json()), ['cursor']);

  // A fresh listener on the new cursor wakes only after another write.
  const batchCursor = notified.json().cursor;
  const batchWait = f.app.inject({url:`/v1/events?since=${batchCursor}`,headers:a.headers}).then(response => response);
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.app.inject({method:'POST',url:`/v1/vaults/${vault}/batches`,headers:a.headers, payload:{batchId:randomUUID(),revisions:[{id:randomUUID(),noteId:'event-note',parents:[],payload:opaque}]}});
  const batchNotified = await batchWait;
  assert.equal(batchNotified.statusCode, 200);
  assert.notEqual(batchNotified.json().cursor, batchCursor);

  // A write publishes again: the cursor advances after a permanent delete.
  const beforeDelete = (await f.app.inject({url:'/v1/events',headers:a.headers})).json().cursor;
  await f.app.inject({method:'DELETE',url:`/v1/vaults/${vault}/notes/event-note`,headers:a.headers});
  assert.notEqual((await f.app.inject({url:'/v1/events',headers:a.headers})).json().cursor, beforeDelete);

  // A revoked device's pending wait is rejected when auth is rechecked.
  const revokeCursor = (await f.app.inject({url:'/v1/events',headers:a.headers})).json().cursor;
  const revokedWait = f.app.inject({url:`/v1/events?since=${revokeCursor}`,headers:a.headers}).then(response => response);
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.app.inject({method:'DELETE',url:`/v1/devices/${a.deviceId}`,headers:a.headers});
  // Shutdown drains outstanding waits, with authentication checked again.
  await f.app.close();
  assert.equal((await revokedWait).statusCode,401);
});
