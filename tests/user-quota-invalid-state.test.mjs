import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the production repository with a transaction-owned in-memory stub;
// no application database or network is opened.
const source = readFileSync(new URL('../src/db/repositories/users.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(js, { exports, require(name) {
  if (name === '../client.js') return { getDb() { throw new Error('unexpected database access'); } };
  if (name === 'crypto') return { randomUUID() { return 'unused'; } };
  throw new Error(`unexpected import ${name}`);
} });
const repo = new exports.UserRepository();
function run(limit, used) {
  let writes = 0;
  const db = { prepare(sql) {
    if (sql.includes('SELECT * FROM users')) return { get: () => ({ id: 'user', daily_limit: limit, enabled: 1 }) };
    if (sql.includes('SELECT used FROM user_daily_quota')) return { get: () => used === undefined ? undefined : { used } };
    if (sql.includes('INSERT INTO user_daily_quota')) return { run: () => { writes++; } };
    throw new Error('unexpected SQL');
  } };
  let result, error;
  try { result = repo.reserveDailyQuota('synthetic', new Date('2026-01-01T00:00:00Z'), db); } catch (e) { error = e; }
  return { result, error, writes };
}

test('invalid persisted quota state fails closed without charging', () => {
  for (const [limit, used] of [['unlimited', 0], [1.5, 0], [-1, 0], [Number.MAX_SAFE_INTEGER + 1, 0], [2, 'corrupt'], [2, null], [2, -1], [2, 0.5], [2, Number.MAX_SAFE_INTEGER + 1]]) {
    const outcome = run(limit, used);
    assert.equal(outcome.error?.message, 'Invalid user quota state', `invalid limit=${limit} used=${used}`);
    assert.equal(outcome.writes, 0);
  }
});

test('valid quota permits a reservation and denies an exhausted account', () => {
  const permitted = run(2, 1);
  assert.equal(permitted.result.allowed, true); assert.equal(permitted.result.used, 2); assert.equal(permitted.writes, 1);
  const exhausted = run(2, 2);
  assert.equal(exhausted.result.allowed, false); assert.equal(exhausted.writes, 0);
});
