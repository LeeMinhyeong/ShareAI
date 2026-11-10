import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/upstream/account-quota.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

function fixture({used = 1, failCommit = false} = {}) {
  let writes = 0, commits = 0, starts = 0, open = false;
  const db = {prepare(sql) {
    if (sql.includes('SELECT status, state_revision')) return {get: () => ({status:'active',state_revision:1,credential_revision:1,daily_quota:1})};
    if (sql.includes('account_429_cooldowns') || sql.includes('account_429_v2_restrictions')) return {get: () => undefined};
    if (sql.includes('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=? AND attempt_id=?')) return {get: () => open ? 1 : undefined};
    if (sql.includes('SELECT 1 FROM main.ordinary_account_attempts')) return {get: () => undefined};
    if (sql.includes('SELECT day,used,legacy_ambiguous')) return {get: () => ({day:new Date().toISOString().slice(0,10),used,legacy_ambiguous:0})};
    if (sql.includes('UPDATE account_daily_reservations')) return {run: () => { writes++; used++; }};
    if (sql.includes('INSERT INTO main.ordinary_account_attempts')) return {run: () => { writes++; open = true; }};
    throw new Error(`unexpected SQL: ${sql}`);
  }};
  const exports = {};
  const withAsyncWriter = fn => {
    const result = fn(db);
    if (failCommit) throw new Error('synthetic commit failure');
    commits++;
    return result;
  };
  vm.runInNewContext(code, {exports, Promise, Date, Number, require(name) {
    if (name === '../db/async-writer.js') return {withAsyncWriter};
    // No v2 restriction in this fixture; the real schema check needs a real database.
    if (name === '../db/account-429-v2-store.js') return {assert429V2Schema() {}};
    if (name === '../db/durable-ledger-foundation.js') return {createOpenAttemptCallback: () => () => {}};
    if (name === './inference.js') return {UpstreamError: class extends Error {}};
    if (name === './oauth.js') return {parseStoredCredentials: () => null, decodeJwt: () => null};
    if (name === '../db/repositories/accounts.js') return {refreshFingerprint: () => 'unused'};
    if (name === 'crypto') return {randomUUID: () => 'attempt'};
    throw new Error(`unexpected import ${name}`);
  }});
  const account = {id:'a',provider:'openai',credentials:'synthetic',stateRevision:1,credentialRevision:1};
  const invoke = () => exports.invokeAccountAttempt(account, new AbortController().signal, () => {starts++; return Promise.resolve('response');});
  return {exports, invoke, state: () => ({writes,commits,starts})};
}

test('exhaustion is retryable only after a committed read-only admission', async () => {
  const f = fixture();
  await assert.rejects(f.invoke(), e => e instanceof f.exports.AccountQuotaExhausted);
  assert.deepEqual(f.state(), {writes:0,commits:1,starts:0});
});

test('a commit failure cannot be mistaken for retryable exhaustion', async () => {
  const f = fixture({failCommit:true});
  await assert.rejects(f.invoke(), e => e.message === 'synthetic commit failure' && !(e instanceof f.exports.AccountQuotaExhausted));
  assert.deepEqual(f.state(), {writes:0,commits:0,starts:0});
});

test('available quota still reserves, opens, and starts once', async () => {
  const f = fixture({used:0});
  assert.equal(await f.invoke(), 'response');
  assert.deepEqual(f.state(), {writes:2,commits:2,starts:1});
});
