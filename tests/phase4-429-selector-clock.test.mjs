import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--isolated') {
  test('429 candidate remains unavailable when wall clock jumps forward', async () => {
    const result = await new Promise(resolve => {
      let child, timer, grace, settled = false, stdout = '', stderr = '', overflow = false, timedOut = false;
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve(result); };
      try {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
          stream.setEncoding('utf8');
          stream.on('error', () => {});
          stream.on('data', data => {
            if (isError) stderr += data; else stdout += data;
            if (stdout.length + stderr.length > 65536 && !overflow) { overflow = true; child.kill(); }
          });
        }
        child.on('error', () => finish({ closed: false, stdout, stderr, overflow }));
        child.on('close', (status, signal) => finish({ closed: true, status, signal, stdout, stderr, overflow, timedOut }));
        timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
        grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish({ closed: false, stdout, stderr, overflow }); }, 18000);
      } catch { finish({ closed: false, stdout, stderr, overflow }); }
    });
    assert.equal(result.closed && !result.overflow && !result.timedOut && result.signal === null, true, 'isolated child closure not confirmed');
    const stage = ['setup','siwc-initial','siwc-restricted','siwc-restored','schema-check'].find(s => result.stdout.includes(`FIXTURE_FAILURE:${s}\n`));
    assert.equal(result.status, 0, result.stdout.includes('EARLY_ELIGIBILITY') ? '429 account became eligible after wall-clock jump' : `isolated fixture failed: ${stage ?? 'unknown'}`);
  });
} else {
  let stage = 'setup';
  try {
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const vm = await import('node:vm');
    const require = createRequire(import.meta.url);
    const ts = require('typescript');
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
    const storeExports = {};
    const storeContext = vm.createContext({ exports: storeExports, module: { exports: storeExports }, process: Object.freeze({ env: Object.freeze(Object.create(null)) }), require() { throw new Error('Unexpected import'); } });
    const storeSource = readFileSync(new URL('../src/db/account-429-v2-store.ts', import.meta.url), 'utf8');
    new vm.Script(ts.transpileModule(storeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(storeContext);
    const store = storeContext.module.exports;
    db.transaction(() => store.provision429V2(db)).immediate();
    db.exec(`CREATE TABLE account_429_cooldowns (kind TEXT NOT NULL, account_id TEXT NOT NULL, until_at INTEGER NOT NULL);
      CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL);
      CREATE TABLE account_daily_reservations (account_id TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL, legacy_ambiguous INTEGER NOT NULL);
      CREATE TABLE siwc_accounts(id TEXT); CREATE TABLE siwc_credentials(id TEXT);
      CREATE TABLE siwc_access_policy(account_id TEXT,enabled INTEGER,scope TEXT);
      CREATE TABLE siwc_routing_settings(account_id TEXT,priority INTEGER,weight INTEGER);
      CREATE TABLE siwc_access_users(account_id TEXT,user_id TEXT); CREATE TABLE users(id TEXT,enabled INTEGER);
      CREATE TABLE siwc_usage_logs(account_id TEXT,success INTEGER,timestamp TEXT);
      CREATE TABLE siwc_account_attempts(account_id TEXT);
      INSERT INTO siwc_accounts VALUES('A'); INSERT INTO siwc_credentials VALUES('A');
      INSERT INTO siwc_access_policy VALUES('A',1,'all'); INSERT INTO users VALUES('U',1);`);
      let wall = Date.parse('2030-01-01T00:00:00.000Z');
      class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } static now() { return wall; } }
      const accounts = ['A', 'B'].map(id => ({ id, provider: 'anthropic', credentialType: 'api_key', priority: 0, weight: 1, dailyQuota: 0, stateRevision: 1, status: 'active' }));
      class Accounts { findActiveByProvider() { return accounts; } }
      const imports = Object.assign(Object.create(null), {
        '../db/repositories/accounts.js': { AccountRepository: Accounts },
        '../db/client.js': { getDb: () => db },
        '../db/account-429-v2-store.js': store,
        '../db/async-writer.js': {},
        '../utils/logger.js': { logger: Object.freeze({warn() {}}) },
        '../utils/encryption.js': { CredentialVault: class {} },
        '../upstream/siwc-store.js': { SiwcStore: class { readSnapshot() { return {revision:'test', credential:{scopes:['chatgpt.tokens.use.direct'],savedAt:'2030-01-01T00:00:00.000Z',expiresIn:86400}}; } } },
        '../upstream/oauth.js': { decodeJwt: () => undefined, parseStoredCredentials: () => undefined },
        '../db/usage-utc.js': { parseUsageUtc: () => null },
      });
      const source = readFileSync(new URL('../src/account-pool/manager.ts', import.meta.url), 'utf8');
      const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const exports = {};
      const context = vm.createContext({ exports, module: { exports }, Date: FakeDate, process: Object.freeze({ env: Object.freeze(Object.create(null)) }), console: Object.freeze({}), require(name) { if (!Object.hasOwn(imports, name)) throw new Error('Unexpected import'); return imports[name]; } });
      new vm.Script(output, { filename: 'manager.ts' }).runInContext(context);
      const pool = new context.module.exports.AccountPoolManager();
      if (!pool.getCandidates('anthropic', 'round_robin').some(a => a.id === 'A')) throw new Error('MISSING_INITIAL_A');
      db.transaction(() => store.arm429V2(db, 'upstream', 'A', 60000)).immediate();
      db.prepare('INSERT INTO account_429_cooldowns(kind,account_id,until_at) VALUES(?,?,?)').run('upstream', 'A', wall + 60000);
      const before = pool.getCandidates('anthropic', 'round_robin').map(a => a.id);
      if (before.length !== 1 || before[0] !== 'B') throw new Error('POSITIVE_CONTROL_FAILED');
      wall += 61000;
      const after = pool.getCandidates('anthropic', 'round_robin').map(a => a.id);
      if (after.includes('A')) { process.stdout.write('EARLY_ELIGIBILITY\n'); process.exitCode = 1; }
      if (!after.includes('B')) throw new Error('MISSING_B');
      db.transaction(() => db.prepare("DELETE FROM main.account_429_v2_restrictions WHERE kind='upstream' AND account_id='A'").run()).immediate();
      if (!pool.getCandidates('anthropic', 'round_robin').some(a => a.id === 'A')) throw new Error('MISSING_RESTORED_A');
      const opts = {excludeUpstream: new Set(['A','B'])};
      stage = 'siwc-initial';
      if ((await pool.selectCandidate('U','model','openai','round_robin',opts))?.kind !== 'siwc') throw new Error('MISSING_INITIAL_SIWC');
      db.transaction(() => store.arm429V2(db, 'siwc', 'A', 1000)).immediate();
      stage = 'siwc-restricted';
      wall += 10000;
      if (await pool.selectCandidate('U','model','openai','round_robin',opts)) throw new Error('EARLY_SIWC');
      db.transaction(() => db.prepare("DELETE FROM main.account_429_v2_restrictions WHERE kind='siwc' AND account_id='A'").run()).immediate();
      stage = 'siwc-restored';
      if ((await pool.selectCandidate('U','model','openai','round_robin',opts))?.kind !== 'siwc') throw new Error('MISSING_RESTORED_SIWC');
      db.prepare('DELETE FROM account_429_v2_schema_marker').run();
      stage = 'schema-check';
      assert.throws(() => pool.getCandidates('anthropic','round_robin'), /Unsafe 429 v2/);
    } finally { db.close(); }
  } catch { process.stdout.write(`FIXTURE_FAILURE:${stage}\n`); process.exitCode = 1; }
}
