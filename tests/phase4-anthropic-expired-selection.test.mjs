import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The child starts without inherited configuration before any application module loads.
if (process.argv[2] !== '--synthetic-child') {
  test('Anthropic selection excludes expired non-refreshable OAuth', () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--synthetic-child'], {
      env: {}, cwd: dirname(dirname(fileURLToPath(import.meta.url))), encoding: 'utf8', timeout: 20000,
    });
    assert.equal(child.error?.code, undefined, 'synthetic child did not complete');
    assert.equal(child.status, 0, `synthetic child failed: ${child.stderr}`);
    assert.equal(child.stdout.trim(), 'synthetic-cases: 18');
  });
} else {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const http = await import('node:http');
  const https = await import('node:https');
  const dns = await import('node:dns');
  const deny = () => { throw new Error('network disabled'); };
  net.default.connect = net.default.createConnection = deny;
  net.default.Socket.prototype.connect = deny;
  net.default.Server.prototype.listen = deny;
  tls.default.connect = deny;
  http.default.request = http.default.get = http.default.createServer = deny;
  https.default.request = https.default.get = https.default.createServer = deny;
  dns.default.lookup = dns.default.resolve = deny;
  globalThis.fetch = deny;

  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const { DatabaseSync } = await import('node:sqlite');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA temp_store=MEMORY');
  const db = {
    get inTransaction() { return native.isTransaction; },
    exec: sql => native.exec(sql),
    prepare(sql) {
      const statement = native.prepare(sql);
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        iterate: (...args) => statement.iterate(...args),
        run: (...args) => statement.run(...args),
        safeIntegers() { statement.setReadBigInts(true); return this; },
      };
    },
  };
  const noCall = () => { throw new Error('unexpected dependency'); };
  const fakeLogger = { warn: noCall, info: noCall, error: noCall };
  const now = 1700000000000;
  class FixedDate extends Date { static now() { return now; } }
  function load(relative, dependencies) {
    const source = readFileSync(resolve(root, relative), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    const context = vm.createContext({ exports, module: { exports }, process: { env: {} }, Date: FixedDate, Buffer, AbortController, URLSearchParams, setTimeout: noCall, fetch: noCall,
      require(name) { if (!Object.hasOwn(dependencies, name)) throw new Error(`unexpected import: ${name}`); return dependencies[name]; } });
    new vm.Script(output, { filename: relative }).runInContext(context);
    return context.module.exports;
  }
  try {
    // Full real OAuth module; its only runtime imports are supplied inertly.
    const oauth = load('src/upstream/oauth.ts', { crypto: {}, http: {}, '../utils/logger.js': { logger: fakeLogger } });
    const v2 = load('src/db/account-429-v2-store.ts', {});
    const usage = load('src/db/usage-utc.ts', {});
    native.exec('BEGIN IMMEDIATE');
    v2.provision429V2(db);
    native.exec('COMMIT');
    native.exec('CREATE TABLE ordinary_account_attempts (account_id TEXT); CREATE TABLE account_daily_reservations (account_id TEXT, day TEXT, used INTEGER, legacy_ambiguous INTEGER); CREATE TABLE usage_logs (upstream_account_id TEXT, success INTEGER, timestamp TEXT)');
    let accounts = [];
    class FakeRepository { findActiveByProvider(provider) { return accounts.filter(a => a.provider === provider); } hasRefreshIntent() { return false; } }
    const manager = load('src/account-pool/manager.ts', {
      '../db/repositories/accounts.js': { AccountRepository: FakeRepository },
      '../db/client.js': { getDb: () => db },
      '../db/account-429-v2-store.js': v2,
      '../db/async-writer.js': { withAsyncWriter: noCall },
      '../utils/logger.js': { logger: fakeLogger },
      '../utils/encryption.js': { CredentialVault: class {} },
      '../upstream/siwc-store.js': { SiwcStore: class {} },
      '../upstream/oauth.js': oauth,
      '../db/usage-utc.js': usage,
    });

    const serialized = (expiry, refresh) => JSON.stringify({ kind: 'oauth', accessToken: 'synthetic-access', expiresAt: expiry, refreshToken: refresh });
    const account = (id, priority, credentials, credentialType = 'oauth') => ({ id, priority, credentials, credentialType, provider: 'anthropic', weight: 1, dailyQuota: 0, stateRevision: 0, status: 'active', usedToday: 0 });
    const b = account('B', 1, serialized(now + 600000, null));
    let checks = 0;
    async function check(label, a, expected) {
      accounts = [a, b];
      const pool = new manager.AccountPoolManager();
      assert.equal(pool.getCandidates('anthropic', 'priority')[0]?.id, expected, `${label}: candidate order`);
      assert.equal((await pool.selectAccount('synthetic-user', 'synthetic-model', 'anthropic', 'priority'))?.id, expected, `${label}: selectAccount`);
      assert.equal((await pool.selectCandidate('synthetic-user', 'synthetic-model', 'anthropic', 'priority'))?.id, expected, `${label}: selectCandidate`);
      checks++;
    }
    assert.equal(oauth.parseStoredCredentials(serialized(now - 1000, null)).kind, 'oauth');
    assert.equal(oauth.parseStoredCredentials('{malformed'), null);
    await check('expired without refresh', account('A', 0, serialized(now - 1000, null)), 'B');
    await check('expired with empty refresh', account('A', 0, serialized(now - 1000, '')), 'B');
    await check('unexpired without refresh', account('A', 0, serialized(now + 600000, null)), 'A');
    await check('expired with refresh', account('A', 0, serialized(now - 1000, 'synthetic-refresh')), 'A');
    await check('expired with truthy whitespace refresh', account('A', 0, serialized(now - 1000, ' ')), 'A');
    await check('unknown expiry', account('A', 0, serialized(null, null)), 'A');
    await check('malformed legacy credential', account('A', 0, '{malformed'), 'A');
    await check('API key', account('A', 0, 'synthetic-api-key', 'api_key'), 'A');
    await check('zero expiry without refresh', account('A', 0, serialized(0, null)), 'B');
    await check('false expiry without refresh', account('A', 0, serialized(false, null)), 'B');
    const failures = [];
    for (const [label, expiry, refresh, expected] of [
      ['zero expiry with refresh', 0, 'synthetic-refresh', 'B'],
      ['false expiry with refresh', false, 'synthetic-refresh', 'B'],
      ['string zero expiry with refresh', '0', 'synthetic-refresh', 'A'],
      ['nonnumeric expiry without refresh', 'nonnumeric', null, 'A'],
      ['negative expiry with refresh', -1, 'synthetic-refresh', 'A'],
      ['truthy non-string refresh', -1, { synthetic: true }, 'A'],
    ]) {
      try { await check(label, account('A', 0, serialized(expiry, refresh)), expected); }
      catch (error) { failures.push(`${label}: ${error.message}`); }
    }
    // Least-used must both apply eligibility and continue to sort eligible accounts.
    for (const [label, expiry, expected, insertUsage] of [
      ['least-used excludes falsey expiry', 0, 'B', false],
      ['least-used sorts refreshable account', '0', 'B', true],
    ]) {
      try {
        accounts = [account('A', 0, serialized(expiry, 'synthetic-refresh')), b];
        if (insertUsage) native.prepare('INSERT INTO usage_logs VALUES (?, 1, ?)').run('A', new Date(now).toISOString());
        const pool = new manager.AccountPoolManager();
        const ids = pool.getCandidates('anthropic', 'least_used').map(a => a.id);
        assert.equal(ids.join(','), insertUsage ? 'B,A' : 'B', label);
        assert.equal((await pool.selectAccount('synthetic-user', 'synthetic-model', 'anthropic', 'least_used'))?.id, expected, label);
        assert.equal((await pool.selectCandidate('synthetic-user', 'synthetic-model', 'anthropic', 'least_used'))?.id, expected, label);
        checks++;
      } catch (error) { failures.push(`${label}: ${error.message}`); }
      finally { native.exec('DELETE FROM usage_logs'); }
    }
    assert.deepEqual(failures, []);
    assert.equal(checks, 18);
    process.stdout.write('synthetic-cases: 18\n');
  } finally { native.close(); }
}
