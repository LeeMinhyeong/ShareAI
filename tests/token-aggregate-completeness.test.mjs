import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// Strictly allowlisted dependencies: never import the production client or config.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Database = require('better-sqlite3');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, dependencies = {}, transform = source => source) {
  const source = ts.transpileModule(transform(read(path)), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${source}\n})`)(exports, name => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  });
  return exports;
}
const originalNow = Date.now;
const db = new Database(':memory:');
// Register cleanup immediately, including if subsequent setup throws.
after(() => {
  try { db.close(); assert.equal(db.open, false, 'fixture database must close'); }
  finally { Date.now = originalNow; }
});
db.exec(load('../src/db/schema.ts').SQL_SCHEMA);
const ddl = read('../src/db/client.ts').match(/CREATE TABLE IF NOT EXISTS siwc_usage_logs \([\s\S]*?\n\s*\);/);
assert.ok(ddl, 'production SIWC history DDL not found');
db.exec(ddl[0]);
const utc = load('../src/db/usage-utc.ts');
const { UsageLogRepository } = load('../src/db/repositories/usage-logs.ts', {
  '../client.js': {getDb: () => db}, '../usage-utc.js': utc, crypto: require('crypto'),
});
const repo = new UsageLogRepository();
db.exec(`INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','hash','name','u@example.invalid','free');
  INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES('a','account','openai','api_key','synthetic','active','2024-01-01');
  CREATE TABLE IF NOT EXISTS siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL);
  INSERT INTO siwc_accounts(id,name) VALUES('s','siwc');`);
const ordinary = db.prepare(`INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?, 'u','a',?,'m','openai',?,?,?,0)`);
const siwc = db.prepare(`INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES(?,'u','s',?,'m','openai',?,?,?,0,0)`);
Date.now = () => Date.parse('2025-05-05T12:00:00.000Z');
const now = () => new Date(Date.now()).toISOString();

test('token totals distinguish complete SIWC and ambiguous ordinary history', () => {
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:0, successRequests:0, totalTokens:0, totalTokensComplete:true});
  siwc.run('zero',now(),0,0,1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:1, successRequests:1, totalTokens:0, totalTokensComplete:true});
  siwc.run('known',now(),2,4,1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:2, successRequests:2, totalTokens:6, totalTokensComplete:true});
  siwc.run('unknown',now(),null,null,0);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:3, successRequests:2, totalTokens:6, totalTokensComplete:false});
  db.prepare("DELETE FROM siwc_usage_logs WHERE id='unknown'").run();
  siwc.run('partial',now(),3,null,1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:3, successRequests:3, totalTokens:6, totalTokensComplete:false});
  siwc.run('unknown',now(),null,null,0);
  ordinary.run('legacy-zero',now(),0,0,0);
  ordinary.run('legacy-nonzero',now(),1,2,1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:6, successRequests:4, totalTokens:9, totalTokensComplete:false});
  assert.deepEqual(repo.getAccountTodayStats('a'), {totalRequests:2, successRequests:1, totalTokens:3, totalTokensComplete:false});
  assert.deepEqual(repo.getAccountTodayStats('missing'), {totalRequests:0, successRequests:0, totalTokens:0, totalTokensComplete:true});
  db.prepare('DELETE FROM siwc_usage_logs').run();
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:2, successRequests:1, totalTokens:3, totalTokensComplete:false});
});

test('SIWC-only aggregate crossing the safe integer boundary is incomplete', () => {
  db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
  siwc.run('safe-max',now(),Number.MAX_SAFE_INTEGER,0,1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:1,successRequests:1,totalTokens:Number.MAX_SAFE_INTEGER,totalTokensComplete:true});
  siwc.run('safe-one',now(),1,0,1);
  const expected = {totalRequests:2,successRequests:2,totalTokens:Number.MAX_SAFE_INTEGER,totalTokensComplete:false};
  assert.deepEqual(repo.getTodayStats('u'), expected);
  // Negative control disables only the aggregate guard in a transpiled copy.
  const dependencies = {'../client.js': {getDb: () => db}, '../usage-utc.js': utc, crypto: require('crypto')};
  const {UsageLogRepository: Mutant} = load('../src/db/repositories/usage-logs.ts', dependencies, source => {
    const needle = '!result.uncertain && Number.isSafeInteger(result.total_tokens)';
    // The guard is shared by the user and account aggregates; the control disables both.
    assert.equal(source.split(needle).length, 3, 'aggregate guard mutation must apply to both aggregates');
    return source.replaceAll(needle, '!result.uncertain');
  });
  assert.equal(new Mutant().getTodayStats('u').totalTokensComplete, true);
});

// ADR 0011: totalTokens is the sum of known (valid) counts only; invalid rows add nothing and mark it incomplete.
for (const [label, value, total] of [['negative',-1,0], ['fraction',1.5,0], ['nonnumeric','bad',0], ['null',null,0]]) {
  test(`SIWC ${label} without ordinary rows is incomplete`, () => {
    db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
    siwc.run(label,now(),value,0,1);
    assert.deepEqual(repo.getTodayStats('u'), {totalRequests:1,successRequests:1,totalTokens:total,totalTokensComplete:false});
  });
}

test('today queries isolate users, accounts and the captured as-of time', () => {
  db.exec(`DELETE FROM usage_logs; DELETE FROM siwc_usage_logs;
    INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('v','hash2','name2','v@example.invalid','free');
    INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES('b','account2','openai','api_key','synthetic','active','2024-01-01');`);
  siwc.run('good',now(),0,0,1);
  db.prepare(`INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES('other','v','s',?,'m','openai',NULL,NULL,0,0,0)`).run(now());
  siwc.run('future','2025-05-05T12:00:00.001Z',null,null,0);
  db.prepare(`INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES('other-account','v','b',?,'m','openai',1,2,1,0)`).run(now());
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:1,successRequests:1,totalTokens:0,totalTokensComplete:true});
  assert.deepEqual(repo.getTodayStats('v'), {totalRequests:2,successRequests:1,totalTokens:3,totalTokensComplete:false});
  assert.deepEqual(repo.getAccountTodayStats('a'), {totalRequests:0,successRequests:0,totalTokens:0,totalTokensComplete:true});
  assert.deepEqual(repo.getAccountTodayStats('b'), {totalRequests:1,successRequests:1,totalTokens:3,totalTokensComplete:false});
});

test('today stats aggregate in SQL without materializing unsafe integer rows', () => {
  for (const method of ['getTodayStats', 'getAccountTodayStats']) {
    const source = UsageLogRepository.prototype[method].toString();
    assert.match(source, /\.get\(/);
    assert.doesNotMatch(source, /\.all\(/);
  }
});

test('UTC bounds include supported formats and reject malformed, future and past', () => {
  db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
  siwc.run('midnight', '2025-05-05T00:00:00.000Z', 2, 0, 1);
  siwc.run('sqlite', '2025-05-05 11:59:59', 3, 0, 1);
  siwc.run('asof', '2025-05-05T12:00:00.000Z', 5, 0, 0);
  siwc.run('yesterday', '2025-05-04T23:59:59.999Z', 100, 0, 1);
  siwc.run('after', '2025-05-05T12:00:00.001Z', 100, 0, 1);
  siwc.run('malformed', '2025-05-05T10:00:00.000+00:00', 100, 0, 1);
  ordinary.run('ordinary-good', '2025-05-05 00:00:00', 7, 0, 1);
  ordinary.run('ordinary-after', '2025-05-05T12:00:00.001Z', 100, 0, 1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:4,successRequests:3,totalTokens:17,totalTokensComplete:false});
  assert.deepEqual(repo.getAccountTodayStats('a'), {totalRequests:1,successRequests:1,totalTokens:7,totalTokensComplete:false});
});

test('invalid SIWC row cannot be made complete by dropping row validation', () => {
  db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
  siwc.run('invalid-negative', now(), -1, 0, 1);
  assert.equal(repo.getTodayStats('u').totalTokensComplete, false);
  const dependencies = {'../client.js': {getDb: () => db}, '../usage-utc.js': utc, crypto: require('crypto')};
  const {UsageLogRepository: Mutant} = load('../src/db/repositories/usage-logs.ts', dependencies, source => {
    const needle = '!result.uncertain && Number.isSafeInteger(result.total_tokens)';
    assert.equal(source.split(needle).length, 3, 'guard shared by user and account aggregates');
    return source.replaceAll(needle, 'Number.isSafeInteger(result.total_tokens)');
  });
  assert.equal(new Mutant().getTodayStats('u').totalTokensComplete, true);
});

test('single SIWC row integer addition overflow remains incomplete', () => {
  db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
  siwc.run('pair-overflow', now(), 4611686018427387904n, 4611686018427387904n, 1);
  // An out-of-range row is not a known count (ADR 0011): it contributes nothing and the total is incomplete.
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:1,successRequests:1,totalTokens:0,totalTokensComplete:false});
});

test('valid rows whose sum exceeds the safe range are clamped and incomplete', () => {
  db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
  siwc.run('valid-max-1',now(),Number.MAX_SAFE_INTEGER,0,1);
  siwc.run('valid-max-2',now(),Number.MAX_SAFE_INTEGER,0,1);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:2,successRequests:2,totalTokens:Number.MAX_SAFE_INTEGER,totalTokensComplete:false});
});
test('rows beyond the safe range neither throw nor count as known tokens', () => {
  db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
  const large = 4611686018427387904n;
  siwc.run('huge1',now(),large,0,1);
  siwc.run('huge2',now(),large,0,0);
  ordinary.run('huge3',now(),large,0,1);
  ordinary.run('huge4',now(),large,0,0);
  assert.deepEqual(repo.getTodayStats('u'), {totalRequests:4,successRequests:2,totalTokens:0,totalTokensComplete:false});
  assert.deepEqual(repo.getAccountTodayStats('a'), {totalRequests:2,successRequests:1,totalTokens:0,totalTokensComplete:false});
});
