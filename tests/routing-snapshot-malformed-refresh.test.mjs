import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

// Start the TS transformer before chdir so its Windows child cannot hold the fixture directory open.
await import('../src/protocol/types.ts');

// Windows Hermes scratch only; no system-temp fallback. The root check does not
// eliminate ancestor-link, hard-link, or replacement races.
const root = 'C:/Users/Administrator/AppData/Local/hermes/cache/scratch';

test('snapshot contains malformed refresh tokens without hiding valid accounts', async () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const patches = [], cleanupErrors = [];
  let dir, closeDatabase, primaryError, failed = false;
  let databaseClosed = true, cwdRestored = true;
  const denyNetwork = () => { throw new Error('Network disabled for snapshot fixture'); };
  const patch = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    patches.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
    Object.defineProperty(object, key, { configurable: true, writable: true, value: denyNetwork });
  };
  const cleanup = fn => { try { fn(); } catch (error) { cleanupErrors.push(error); } };
  try {
    // Deny fetch, sockets, UDP and DNS before fixture creation and imports.
    patch(globalThis, 'fetch');
    patch(net.Socket.prototype, 'connect');
    patch(net.Server.prototype, 'listen');
    patch(dgram, 'createSocket');
    patch(dgram.Socket.prototype, 'bind');
    patch(dgram.Socket.prototype, 'send');
    for (const object of [dns, dns.promises]) {
      patch(object, 'Resolver');
      for (const key of Object.keys(object)) {
        if ((key === 'lookup' || key === 'lookupService' || key === 'reverse' || key.startsWith('resolve')) && typeof object[key] === 'function') patch(object, key);
      }
    }
    syncBuiltinESMExports();
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe fixture root');
    dir = fs.mkdtempSync(path.join(root, 'snapshot-refresh-fixture-'));
    process.chdir(dir);
    for (const key of Object.keys(process.env)) {
      if (!['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC'].includes(key)) delete process.env[key];
    }
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `sqlite:${path.join(dir, 'fixture.sqlite')}`, ENCRYPTION_KEY: 'a'.repeat(64),
      ADMIN_API_KEY: 'fixture-admin-key-000000', LOG_LEVEL: 'error', LOG_PRETTY: 'false',
      TMP: dir, TEMP: dir, TMPDIR: dir, HOME: dir, USERPROFILE: dir,
    });
    // The production client never creates a database; provision the fixture-owned file.
    await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
    const client = await import('../src/db/client.ts');
    closeDatabase = client.closeDatabase;
    databaseClosed = false;
    const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
    const { routingSnapshot } = await import('../src/routes/routing-snapshot.ts');
    const { accountPool } = await import('../src/account-pool/manager.ts');
    const db = client.getDb();
    assert.equal(db.name, path.join(dir, 'fixture.sqlite'), 'only the fixture-owned database is opened');
    const repo = new AccountRepository();
    const make = (name, refreshToken, expiresAt, include = true) => {
      const credentials = { kind: 'oauth', accessToken: 'fixture-access', accountId: 'fixture-account', expiresAt };
      if (include) credentials.refreshToken = refreshToken;
      return repo.create({ name, provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify(credentials) });
    };
    const future = Date.now() + 3600000;
    const past = Date.now() - 60000;
    const malformed = [false, true, 0, 123, {}].flatMap((value, i) => [make(`bad-future-${i}`, value, future), make(`bad-past-${i}`, value, past)]);
    const valid = [make('valid-string', 'fixture-refresh', past), make('valid-absent', undefined, future, false), make('valid-null', null, future)];
    const emptyFuture = make('empty-future', '', future);
    const emptyPast = make('empty-past', '', past);
    const invalidExpiredNull = make('expired-null', null, past);
    const result = routingSnapshot();
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('fixture-refresh'), false, 'snapshot must not expose refresh token');
    assert.equal(serialized.includes('fixture-access'), false, 'snapshot must not expose access token');
    const state = id => result.accounts.find(row => row.kind === 'upstream' && row.id === id)?.state;
    for (const account of malformed) assert.equal(state(account.id), 'unavailable', account.name);
    for (const account of valid) assert.equal(state(account.id), 'no_known_block', account.name);
    assert.equal(state(emptyFuture.id), 'no_known_block');
    assert.equal(state(emptyPast.id), 'unavailable');
    assert.equal(state(invalidExpiredNull.id), 'unavailable');
    const candidates = new Set(accountPool.getCandidates('openai', 'priority').map(a => a.id));
    for (const account of valid) assert.equal(candidates.has(account.id), true, account.name);
    assert.equal(candidates.has(emptyFuture.id), true);
    assert.equal(candidates.has(emptyPast.id), false);
    for (const account of malformed.filter(a => a.name.startsWith('bad-past'))) assert.equal(candidates.has(account.id), false, account.name);
    assert.equal(candidates.has(invalidExpiredNull.id), false);
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    if (closeDatabase) cleanup(() => { closeDatabase(); databaseClosed = true; });
    cleanup(() => { try { process.chdir(originalCwd); } catch (error) { cwdRestored = false; throw error; } });
    // Preserve the fixture if closure or cwd restoration fails. EPERM is an
    // error (including on Windows), never a skip or a reason to retry removal.
    if (dir && databaseClosed && cwdRestored) cleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
    cleanup(() => {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    });
    for (const restore of patches.reverse()) cleanup(restore);
    cleanup(syncBuiltinESMExports);
  }
  if (failed && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'Fixture and cleanup failed');
  if (failed) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed');
});
