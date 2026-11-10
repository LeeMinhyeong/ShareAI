import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real manager with in-memory collaborators; no DB, config or network is loaded.
function manager(accounts, logs, options = {}) {
  const calls = {clock: 0, usage: [], siwcQueries: []};
  const fakeDb = { prepare(sql) {
    if (sql.includes('sqlite_master')) return { get: () => ({ n: options.siwc ? 2 : 0 }) };
    if (sql.includes('FROM siwc_accounts a')) return { all: (...args) => { calls.siwcQueries.push({sql, args}); return options.siwc ?? []; } };
    if (sql.includes('siwc_account_attempts')) return {get: () => undefined};
    if (sql.includes('FROM siwc_usage_logs WHERE')) return {iterate: (id, ...bounds) => { calls.usage.push({kind:'siwc', id, bounds}); return (logs[`siwc:${id}`] ?? []).map(timestamp => ({timestamp})); }};
    if (sql.includes('account_429_cooldowns') || sql.includes('account_429_v2_restrictions') || sql.includes('ordinary_account_attempts') || sql.includes('account_daily_reservations')) return { get: () => undefined };
    if (sql.includes('FROM usage_logs')) return { iterate: (id, ...bounds) => { calls.usage.push({kind:'upstream', id, bounds}); return (logs[id] ?? []).map(timestamp => ({timestamp})); } };
    throw new Error(`Unexpected statement: ${sql}`);
  } };
  class AccountRepository { findActiveByProvider() { return accounts; } }
  const dependencies = {
    '../db/repositories/accounts.js': {AccountRepository},
    '../db/client.js': {getDb: () => fakeDb},
    '../db/async-writer.js': {}, '../utils/logger.js': {logger: {warn() {}}},
    // No v2 restriction is active in this fixture; the real schema check needs a real database.
    '../db/account-429-v2-store.js': {assert429V2Schema() {}},
    '../utils/encryption.js': {CredentialVault: class {}}, '../upstream/siwc-store.js': {SiwcStore: class { readSnapshot() { return {revision:'r', credential:{scopes:['chatgpt.tokens.use.direct'], savedAt:'2099-01-01T00:00:00Z', expiresIn:3600}}; } }}, '../upstream/oauth.js': {},
    '../db/usage-utc.js': {parseUsageUtc: value => { const n = Date.parse(value); return Number.isNaN(n) ? null : n; }},
  };
  const source = readFileSync(new URL('../src/account-pool/manager.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, require: name => { if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`); return dependencies[name]; }, Date, Number, Math, JSON, Map, Set, BigInt, RangeError});
  const pool = new exports.AccountPoolManager(() => { calls.clock++; return Date.parse('2026-06-01T12:00:00.000Z'); });
  pool.calls = calls;
  return pool;
}

const account = (id, priority, usedToday) => ({id, priority, usedToday, weight:1, dailyQuota:0, status:'active', credentialType:'api_key', stateRevision:0});

test('ordinary-only priority uses UTC successes for ties and reports that count', async () => {
  const pool = manager([account('a', 1, 0), account('b', 1, 99), account('c', 2, 0)], {
    a: ['2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'],
    b: ['2026-06-01T09:00:00.000Z'],
    c: [],
  });
  const candidate = await pool.selectCandidate('user', 'model', 'anthropic', 'priority');
  assert.equal(candidate?.id, 'b');
  assert.equal(candidate?.usedToday, 1);
  assert.equal(pool.calls.clock, 1);
  assert.equal(pool.calls.usage.length, 3);
});

test('mixed priority captures one UTC interval and counts each distinct kind once', async () => {
  const pool = manager([account('same', 1, 88), account('other', 1, 77)], {
    same: ['2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z'],
    other: ['2026-06-01T09:00:00.000Z'],
    'siwc:same': [],
  }, {siwc:[{id:'same', priority:1, weight:1, usedToday:55}]});
  const candidate = await pool.selectCandidate('user', 'model', 'openai', 'priority');
  assert.equal(candidate?.kind, 'siwc');
  assert.equal(candidate?.id, 'same');
  assert.equal(candidate?.usedToday, 0);
  assert.equal(pool.calls.clock, 1);
  assert.deepEqual(pool.calls.usage.map(({kind,id}) => `${kind}:${id}`).sort(), ['siwc:same','upstream:other','upstream:same']);
  assert.ok(pool.calls.usage.every(({bounds}) => bounds[2] === '2026-06-01T00:00:00.000Z' && bounds[3] === '2026-06-01T12:00:00.000Z'));
});

test('mixed round robin does not run UTC success counting or sample its clock', async () => {
  const pool = manager([account('same', 1, 7)], {}, {siwc:[{id:'same', priority:1, weight:1, usedToday:3}]});
  const first = await pool.selectCandidate('user', 'model', 'openai', 'round_robin');
  const second = await pool.selectCandidate('user', 'model', 'openai', 'round_robin');
  assert.equal(first?.kind, 'siwc');
  assert.equal(first?.usedToday, 3);
  assert.equal(second?.kind, 'upstream');
  assert.equal(second?.usedToday, 7);
  assert.equal(pool.calls.clock, 0);
  assert.equal(pool.calls.usage.length, 0);
  assert.ok(pool.calls.siwcQueries.every(({sql}) => sql.includes('SELECT COUNT(*) FROM siwc_usage_logs')));
});
