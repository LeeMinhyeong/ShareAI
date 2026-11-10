import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';

test('quota candidate filtering matches reservation validation and reset', async () => {
  const root = 'C:/Users/Administrator/AppData/Local/hermes/cache/scratch';
  const originalCwd = process.cwd(), originalEnv = {...process.env};
  const originalConnect = net.Socket.prototype.connect, originalListen = net.Server.prototype.listen, originalFetch = globalThis.fetch;
  let scratch, closeDatabase, primary, failed = false, closed = true, restored = false;
  const cleanupErrors = [];
  try {
    if (!lstatSync(root).isDirectory() || realpathSync(root).replaceAll('\\', '/').toLowerCase() !== root.toLowerCase()) throw new Error('Unsafe scratch directory');
    scratch = mkdtempSync(path.join(root, 'quota-candidate-'));
    if (!lstatSync(scratch).isDirectory() || readdirSync(scratch).length !== 0 || path.dirname(realpathSync(scratch)).replaceAll('\\', '/').toLowerCase() !== root.toLowerCase()) throw new Error('Unsafe test directory');
    process.chdir(scratch);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${path.join(scratch, 'db.sqlite')}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', ...(originalEnv.SystemRoot ? {SystemRoot:originalEnv.SystemRoot} : {})}); // Windows CSPRNG needs SystemRoot
    await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // the production client never creates a database
    net.Socket.prototype.connect = function () { throw new Error('Network disabled'); };
    net.Server.prototype.listen = function () { throw new Error('Network disabled'); };
    globalThis.fetch = async () => { throw new Error('Network disabled'); };
    const client = await import('../src/db/client.ts');
    closeDatabase = client.closeDatabase;
    const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
    const {AccountPoolManager} = await import('../src/account-pool/manager.ts');
    const {invokeAccountAttempt, settleAccountAttempt, AccountQuotaUnavailable} = await import('../src/upstream/account-quota.ts');
    closed = false;
    const db = client.getDb(), repo = new AccountRepository(), pool = new AccountPoolManager();
    const a = repo.create({name:'candidate', provider:'anthropic', credentialType:'api_key', credentials:'synthetic-a', priority:0, dailyQuota:0});
    const b = repo.create({name:'healthy', provider:'anthropic', credentialType:'api_key', credentials:'synthetic-b', priority:1, dailyQuota:0});
    const put = db.prepare('INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous) VALUES(?,?,?,0) ON CONFLICT(account_id) DO UPDATE SET day=excluded.day, used=excluded.used, legacy_ambiguous=0');
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    let calls = 0;
    const start = async () => { calls++; return new Response('ok'); };
    const choose = () => pool.selectCandidate('synthetic-user', 'synthetic-model', 'anthropic', 'priority');
    put.run(a.id, today, Number.MAX_SAFE_INTEGER);
    await assert.rejects(invokeAccountAttempt(a, new AbortController().signal, start), AccountQuotaUnavailable);
    assert.equal(calls, 0);
    assert.equal((await choose())?.id, b.id, 'today maximum must not mask healthy candidate with unlimited quota');
    let fallbackAttempt;
    await invokeAccountAttempt(b, new AbortController().signal, start, value => { fallbackAttempt = value; });
    await settleAccountAttempt(fallbackAttempt);
    assert.equal(calls, 1, 'healthy fallback dispatches');
    for (const day of ['2000-02-30', '2001-02-29', tomorrow, `${today}T00:00:00Z`]) {
      put.run(a.id, day, 0);
      await assert.rejects(invokeAccountAttempt(a, new AbortController().signal, start), AccountQuotaUnavailable);
      assert.equal((await choose())?.id, b.id, `invalid or future day ${day}`);
    }
    for (const day of ['2000-02-29', '2001-02-28', today]) {
      put.run(a.id, day, 0);
      assert.equal((await choose())?.id, a.id, `valid day ${day}`);
    }
    put.run(a.id, '2000-02-29', Number.MAX_SAFE_INTEGER);
    const candidate = await choose();
    assert.equal(candidate?.id, a.id, 'old maximum resets and remains eligible');
    let attempt;
    await invokeAccountAttempt(candidate.account, new AbortController().signal, start, value => { attempt = value; });
    assert.equal(calls, 2);
    await settleAccountAttempt(attempt);
    assert.deepEqual(db.prepare('SELECT day,used,legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(a.id), {day:today, used:1, legacy_ambiguous:0});
    assert.equal(new Date().toISOString().slice(0, 10), today, 'UTC day changed during test');
  } catch (error) { failed = true; primary = error; }
  finally {
    if (closeDatabase && !closed) {
      try { closeDatabase(); closed = true; } catch (error) { cleanupErrors.push(error); }
    }
    try { process.chdir(originalCwd); restored = true; } catch (error) { cleanupErrors.push(error); }
    if (scratch && closed && restored) {
      try { rmSync(scratch, {recursive:true}); } catch (error) { cleanupErrors.push(error); }
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    net.Socket.prototype.connect = originalConnect;
    net.Server.prototype.listen = originalListen;
    globalThis.fetch = originalFetch;
  }
  if (failed && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'Test and cleanup failed');
  if (failed) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Test cleanup failed');
});
