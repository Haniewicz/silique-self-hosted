import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const opaque = 'synthetic-encrypted:'.padEnd(100, 'x');
// The self-hosted server is single-user: the fixture registers exactly one
// account, so cross-account checks are expressed as unknown-vault checks.
async function fixture(database = ':memory:') {
  const { app, store } = await buildApp({ database, origins: [] });
  const result = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: {
    email: `${randomUUID()}@example.com`, password: 'synthetic test password 12345',
    deviceId: randomUUID(), deviceName: 'disposable',
  }});
  assert.equal(result.statusCode, 201, result.body);
  const headers = { authorization: `Bearer ${result.json().token}` };
  const create = async () => {
    const vault = randomUUID();
    const created = await app.inject({ method: 'PUT', url: `/v1/vaults/${vault}`, headers,
      payload: { keyWrap: opaque, metadata: opaque, expectedVersion: 0 } });
    assert.equal(created.statusCode, 201, created.body);
    return vault;
  };
  return { app, store, headers, create };
}

test('owner deletion permanently retires vault identity, not just its visible notes', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const vault = await f.create(), other = await f.create();
  const result = await f.app.inject({ method: 'DELETE', url: `/v1/vaults/${vault}`, headers: f.headers,
    payload: { expectedVersion: 1 } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { deleted: true, vaultId: vault });
  const listed = (await f.app.inject({ url: '/v1/vaults', headers: f.headers })).json();
  assert.deepEqual(listed.deletedVaults, [vault]);
  assert.deepEqual(listed.vaults.map((v: { id: string }) => v.id), [other]);
  const stale = await f.app.inject({ method: 'PUT', url: `/v1/vaults/${vault}`, headers: f.headers,
    payload: { keyWrap: opaque, metadata: opaque, expectedVersion: 0 } });
  assert.equal(stale.statusCode, 410);
  assert.equal(stale.json().error, 'vault_deleted');
  // The persistent database guard must also stop an old server binary that
  // has no application-level tombstone lookup after a code-only rollback.
  const user = String(f.store.db.prepare('SELECT user_id FROM purged_vaults WHERE id=?').get(vault)!.user_id);
  assert.throws(() => f.store.db.prepare('INSERT INTO vaults(id,user_id,key_wrap,metadata) VALUES(?,?,?,?)').run(vault, user, opaque, opaque), /vault_deleted/);
});

test('deletion removes every child and attributable receipt, wakes the account and rejects stale routes', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const vault = await f.create(), other = await f.create();
  const unrelatedBatch = { batchId: randomUUID(), revisions: [{ id: randomUUID(), noteId: 'keep', parents: [], payload: opaque + 'keep' }] };
  assert.equal((await f.app.inject({ method: 'POST', url: `/v1/vaults/${other}/batches`, headers: f.headers, payload: unrelatedBatch })).statusCode, 200);
  const unrelatedRows = f.store.db.prepare('SELECT * FROM revisions WHERE vault_id=?').all(other);
  const base = `/v1/vaults/${vault}`, asset = randomUUID(), partial = randomUUID();
  const batch = { batchId: randomUUID(), revisions: [
    { id: randomUUID(), noteId: 'ordinary', parents: [], payload: opaque },
    { id: randomUUID(), noteId: 'opaque-hidden-config', parents: [], payload: opaque },
  ] };
  const send = (method: 'PUT'|'POST'|'DELETE'|'GET', suffix: string, payload?: object) =>
    f.app.inject({ method, url: base + suffix, headers: f.headers, ...(payload ? { payload } : {}) });
  assert.equal((await send('PUT', `/images/${asset}/chunks/0`, { noteId: 'ordinary', payload: opaque })).statusCode, 200);
  assert.equal((await send('PUT', `/images/${asset}`, { noteId: 'ordinary', manifest: opaque, chunkCount: 1 })).statusCode, 200);
  assert.equal((await send('PUT', `/images/${partial}/chunks/0`, { noteId: 'orphan', payload: opaque })).statusCode, 200);
  batch.revisions[0] = { ...batch.revisions[0]!, ...{ images: [asset] } };
  assert.equal((await send('POST', '/batches', batch)).statusCode, 200);
  await send('DELETE', '/notes/already-purged');
  const before = (await f.app.inject({ url: '/v1/events', headers: f.headers })).json().cursor;
  assert.equal((await send('DELETE', '', { expectedVersion: 1 })).statusCode, 200);
  for (const table of ['revisions', 'heads', 'purged_notes', 'image_assets', 'image_chunks', 'image_refs', 'vault_batch_receipts']) {
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id=?`).get(vault)!.n, 0, table);
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM batches WHERE id=?').get(batch.batchId)!.n, 0);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.notEqual((await f.app.inject({ url: '/v1/events', headers: f.headers })).json().cursor, before);
  assert.equal((await f.app.inject({ url: '/v1/vaults', headers: f.headers })).json().vaults[0].id, other);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM revisions WHERE vault_id=?').all(other), unrelatedRows);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM batches WHERE id=?').get(unrelatedBatch.batchId)!.n, 1);
  for (const [method, suffix, payload] of [
    ['POST', '/batches', batch], ['GET', '/changes?cursor=999', undefined],
    ['GET', `/images/${asset}`, undefined], ['GET', `/images/${asset}/chunks/0`, undefined],
    ['PUT', `/images/${asset}`, { noteId: 'ordinary', manifest: opaque, chunkCount: 1 }],
    ['PUT', `/images/${asset}/chunks/0`, { noteId: 'ordinary', payload: opaque }],
    ['DELETE', '/notes/ordinary', undefined],
  ] as const) assert.equal((await send(method, suffix, payload)).statusCode, 410, `${method} ${suffix}`);
  // Replays of an acknowledged deletion stay idempotent for the owner.
  assert.equal((await send('DELETE', '', { expectedVersion: 0 })).statusCode, 200);
  assert.equal((await f.app.inject('/.well-known/silique')).json().features.vault_deletion, true);
});

test('rejection and transactional failure preserve data; tombstone survives a real restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silique-vault-delete-'));
  try {
    const path = join(dir, 'synthetic.sqlite');
    const f = await fixture(path), vault = await f.create(), unknown = randomUUID();
    const base = `/v1/vaults/${vault}`;
    assert.equal((await f.app.inject({ method: 'POST', url: base + '/batches', headers: f.headers, payload: { batchId: randomUUID(), revisions: [{ id: randomUUID(), noteId: 'keep-until-commit', parents: [], payload: opaque }] } })).statusCode, 200);
    const before = f.store.db.prepare('SELECT * FROM revisions WHERE vault_id=?').all(vault);
    for (const [url, headers, payload, status] of [
      [base, f.headers, { expectedVersion: 0 }, 409],
      [`/v1/vaults/${unknown}`, f.headers, { expectedVersion: 1 }, 404],
      [base, f.headers, { expectedVersion: 1, extra: 'name' }, 400],
      [base, f.headers, {}, 400],
      [base, {}, { expectedVersion: 1 }, 401],
    ] as const) assert.equal((await f.app.inject({ method: 'DELETE', url, headers, payload })).statusCode, status, url);
    f.store.db.exec("CREATE TRIGGER synthetic_failure BEFORE DELETE ON vaults BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.equal((await f.app.inject({ method: 'DELETE', url: base, headers: f.headers, payload: { expectedVersion: 1 } })).statusCode, 500);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM purged_vaults').get()!.n, 0);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM revisions WHERE vault_id=?').all(vault), before);
    assert.equal((await f.app.inject({ url: '/v1/vaults', headers: f.headers })).json().vaults.length, 1);
    f.store.db.exec('DROP TRIGGER synthetic_failure');
    assert.equal((await f.app.inject({ method: 'DELETE', url: base, headers: f.headers, payload: { expectedVersion: 1 } })).statusCode, 200);
    await f.app.close();
    const g = await buildApp({ database: path, origins: [] });
    try {
      assert.deepEqual((await g.app.inject({ url: '/v1/vaults', headers: f.headers })).json().deletedVaults, [vault]);
      assert.equal((await g.app.inject({ method: 'PUT', url: base, headers: f.headers, payload: { expectedVersion: 0, keyWrap: opaque, metadata: opaque } })).statusCode, 410);
      assert.equal((await g.app.inject({ method: 'DELETE', url: base, headers: f.headers, payload: { expectedVersion: 1 } })).statusCode, 200);
    } finally { await g.app.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy schema upgrade backfills attributable receipts without losing live content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'silique-vault-upgrade-'));
  try {
    const path = join(dir, 'synthetic.sqlite'), f = await fixture(path), vault = await f.create();
    const batch = { batchId: randomUUID(), revisions: [{ id: randomUUID(), noteId: 'legacy', parents: [], payload: opaque }] };
    assert.equal((await f.app.inject({ method: 'POST', url: `/v1/vaults/${vault}/batches`, headers: f.headers, payload: batch })).statusCode, 200);
    const rows = f.store.db.prepare('SELECT * FROM revisions').all();
    // Only new extension objects are removed in this disposable fixture.
    f.store.db.exec('DROP TRIGGER retired_vault_insert; DROP TRIGGER retired_vault_update; DROP TABLE vault_batch_receipts; DROP TABLE purged_vaults;');
    await f.app.close();
    const g = await buildApp({ database: path, origins: [] });
    try {
      assert.deepEqual(g.store.db.prepare('SELECT * FROM revisions').all(), rows);
      assert.equal(g.store.db.prepare('SELECT vault_id FROM vault_batch_receipts WHERE batch_id=?').get(batch.batchId)!.vault_id, vault);
      assert.equal((await g.app.inject({ method: 'DELETE', url: `/v1/vaults/${vault}`, headers: f.headers, payload: { expectedVersion: 1 } })).statusCode, 200);
      assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM batches').get()!.n, 0);
      assert.deepEqual(g.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { await g.app.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
