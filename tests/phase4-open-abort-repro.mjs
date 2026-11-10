// ADR 0016 item 4 reproduction (not in the default glob): does an ordinary
// account's durable OPEN survive a router-initiated abort (client disconnect or
// the 120s inference timer)? Real Express + authenticateUser + forwardChat and a
// test-owned file SQLite; synthetic fetch, no provider, no credentials.
// Run from a cwd without .env: src/config/env.ts calls dotenv.config().
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR), 'absolute TMPDIR required');
assert.equal(existsSync(path.join(process.cwd(), '.env')), false, 'run from a cwd without .env');
const dir = mkdtempSync(path.join(process.env.TMPDIR, 'open-abort-repro-'));
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'});

// Shrink only the 120s inference timer so the timeout path is observable.
const realSetTimeout = globalThis.setTimeout;

const {default: Database} = await import('better-sqlite3');
const {getDb, closeDatabase, initDatabase, provisionFreshSafetySchema} = await import('../src/db/client.ts');
// The production client never creates a database; provision a test-owned fresh one.
{ const raw = new Database(path.join(dir, 'db.sqlite')); raw.transaction(() => provisionFreshSafetySchema(raw)).immediate(); raw.close(); }
initDatabase();
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
const {authenticateUser} = await import('../src/auth/user-auth.ts');
const {forwardChat, INFERENCE_TIMEOUTS} = await import('../src/upstream/forward-chat.ts');
// Shrink the router's own inference limits (ADR 0016 item 3) so its abort path is observable.
Object.assign(INFERENCE_TIMEOUTS, {firstResponseMs:150, idleMs:150});
const db = getDb(), repo = new AccountRepository();
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'), name:'fixture', email:'fixture@example.invalid', tier:'pro', dailyLimit:100});
let handling; const app = express(); app.use(express.json());
app.post('/v1/chat/completions', authenticateUser, (req, res) => { handling = forwardChat(req, res); });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
assert.notEqual(server.address().port, 20128);
const nativeFetch = globalThis.fetch;
const create = (name, priority = 0) => repo.create({name, provider:'openai', credentialType:'api_key', credentials:`sk-${name}`, priority});
const open = id => db.prepare('SELECT account_id FROM ordinary_account_attempts WHERE account_id=?').get(id);
const body = stream => JSON.stringify({model:'gpt-5', stream, messages:[{role:'user', content:'hello'}], router_options:{strategy:'priority'}});
function request(stream = false, {abortAfterFirstChunk = false} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/chat/completions', method:'POST',
      headers:{authorization:'Bearer fixture-key', 'content-type':'application/json'}}, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (abortAfterFirstChunk) { req.destroy(); resolve({status:res.statusCode, aborted:true}); } });
      res.on('end', () => resolve({status:res.statusCode, text}));
      res.on('error', () => resolve({status:res.statusCode, aborted:true}));
    });
    req.on('error', error => abortAfterFirstChunk ? resolve({aborted:true}) : reject(error));
    req.end(body(stream));
  });
}
// Upstream that sends one text delta and then never finishes (a long generation).
const hangingStream = calls => async () => {
  calls.push(1);
  return new Response(new ReadableStream({start(c) {
    c.enqueue(new TextEncoder().encode('data: {"id":"x","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
  }}), {headers:{'content-type':'text/event-stream'}});
};
const bounded = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => realSetTimeout(() => reject(Error(`${label} deadline`)), ms))]);
after(async () => { globalThis.fetch = nativeFetch; globalThis.setTimeout = realSetTimeout; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); rmSync(dir, {recursive:true, force:true}); });

test('client disconnect mid-stream: does the OPEN remain and block the account?', {timeout:10000}, async () => {
  const a = create('disconnect'); const calls = [];
  globalThis.fetch = hangingStream(calls);
  try {
    const first = await bounded(request(true, {abortAfterFirstChunk:true}), 3000, 'first request');
    assert.equal(first.aborted, true);
    await bounded(handling, 3000, 'handler settle');
    const stranded = !!open(a.id);
    const second = await bounded(request(false), 3000, 'follow-up request');
    console.log(`[repro] disconnect: OPEN after abort=${stranded}, follow-up status=${second.status}, provider calls=${calls.length}`);
    assert.equal(stranded, true, 'reproduction: OPEN remains after client disconnect');
    assert.equal(calls.length, 1, 'follow-up must not reach the provider while OPEN remains');
  } finally { globalThis.fetch = nativeFetch; repo.update(a.id, {status:'disabled'}); }
});

test('router inference timeout mid-stream: does the OPEN remain and block the account?', {timeout:10000}, async () => {
  const a = create('timeout'); const calls = [];
  globalThis.fetch = hangingStream(calls);
  try {
    const first = await bounded(request(true), 3000, 'first request');
    await bounded(handling, 3000, 'handler settle');
    const stranded = !!open(a.id);
    const second = await bounded(request(false), 3000, 'follow-up request');
    console.log(`[repro] timeout: first status=${first.status}, has [DONE]=${String(first.text).includes('[DONE]')}, OPEN after timeout=${stranded}, follow-up status=${second.status}, provider calls=${calls.length}`);
    assert.equal(stranded, true, 'reproduction: OPEN remains after router timeout');
    assert.equal(calls.length, 1, 'follow-up must not reach the provider while OPEN remains');
  } finally { globalThis.fetch = nativeFetch; repo.update(a.id, {status:'disabled'}); }
});
