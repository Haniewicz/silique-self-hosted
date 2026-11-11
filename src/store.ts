import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export class ApiError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,envelope TEXT);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS vaults(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),key_wrap TEXT NOT NULL,metadata TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,vault_id TEXT NOT NULL REFERENCES vaults(id),note_id TEXT NOT NULL,parents TEXT NOT NULL,payload TEXT NOT NULL,device_id TEXT NOT NULL REFERENCES devices(id),created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS revisions_vault_seq ON revisions(vault_id,seq);
      CREATE TABLE IF NOT EXISTS heads(vault_id TEXT NOT NULL,note_id TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES revisions(id),PRIMARY KEY(vault_id,note_id,revision_id));
      CREATE TABLE IF NOT EXISTS batches(user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),requester_id TEXT NOT NULL REFERENCES devices(id),requester_key TEXT NOT NULL,approver_id TEXT REFERENCES devices(id),approver_key TEXT,envelope TEXT,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purged_notes(vault_id TEXT NOT NULL REFERENCES vaults(id),note_id TEXT NOT NULL,PRIMARY KEY(vault_id,note_id));
      CREATE TABLE IF NOT EXISTS image_assets(vault_id TEXT NOT NULL REFERENCES vaults(id),note_id TEXT NOT NULL,id TEXT NOT NULL,manifest TEXT,chunk_count INTEGER,PRIMARY KEY(vault_id,id));
      CREATE TABLE IF NOT EXISTS image_chunks(vault_id TEXT NOT NULL,asset_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(vault_id,asset_id,chunk_index),FOREIGN KEY(vault_id,asset_id) REFERENCES image_assets(vault_id,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS image_refs(vault_id TEXT NOT NULL,asset_id TEXT NOT NULL,note_id TEXT NOT NULL,PRIMARY KEY(vault_id,asset_id,note_id),FOREIGN KEY(vault_id,asset_id) REFERENCES image_assets(vault_id,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS purged_vaults(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),deleted_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS retired_vault_insert BEFORE INSERT ON vaults
        WHEN EXISTS(SELECT 1 FROM purged_vaults WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT,'vault_deleted'); END;
      CREATE TRIGGER IF NOT EXISTS retired_vault_update BEFORE UPDATE OF id ON vaults
        WHEN EXISTS(SELECT 1 FROM purged_vaults WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT,'vault_deleted'); END;
      CREATE TABLE IF NOT EXISTS vault_batch_receipts(user_id TEXT NOT NULL,batch_id TEXT NOT NULL,vault_id TEXT NOT NULL REFERENCES vaults(id),PRIMARY KEY(user_id,batch_id),FOREIGN KEY(user_id,batch_id) REFERENCES batches(user_id,id) ON DELETE CASCADE);
      INSERT OR IGNORE INTO vault_batch_receipts(user_id,batch_id,vault_id)
        SELECT b.user_id,b.id,r.vault_id FROM batches b JOIN json_each(b.response,'$.accepted') a JOIN revisions r ON r.id=a.value JOIN vaults v ON v.id=r.vault_id AND v.user_id=b.user_id;
      PRAGMA user_version=1;`);
  }
  async createUser(email: string, password: string) {
    const salt = randomBytes(16).toString('hex');
    const key = await scrypt(password, salt, 64) as Buffer;
    const id = randomUUID();
    // The count check and the INSERT run in a single BEGIN IMMEDIATE
    // transaction so two concurrent registrations cannot both observe zero
    // accounts. SQLite in WAL mode admits at most one writer at a time, and
    // BEGIN IMMEDIATE acquires the write lock up front: a second request
    // blocks until the first commits, then sees the committed row and hits
    // the single-user limit (busy_timeout makes it wait rather than fail).
    return this.transaction(() => {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      if (Number(count.n) >= 1) throw new ApiError(403, 'This is a single-user server: only one account is allowed');
      try { this.db.prepare('INSERT INTO users(id,email,password) VALUES(?,?,?)').run(id,email.toLowerCase(),`${salt}:${key.toString('hex')}`); }
      catch (error) { if (String(error).includes('UNIQUE')) throw new ApiError(409,'Account already exists'); throw error; }
      return id;
    });
  }
  async verifyPassword(email: string, password: string) {
    const user = this.db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
    // A dummy KDF also runs for unknown accounts.
    const [salt, hash] = String(user?.password ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    const candidate = await scrypt(password, salt!, 64) as Buffer;
    if (!user || !timingSafeEqual(candidate,Buffer.from(hash!, 'hex'))) throw new ApiError(401,'Invalid credentials');
    return user;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value=fn(); this.db.exec('COMMIT'); return value; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
