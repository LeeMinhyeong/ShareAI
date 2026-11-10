// ADR 0016 item 3: the router's 120s whole-request inference limit is replaced
// by a per-dispatch first-response limit plus a provider idle limit that every
// received body byte (including SSE comment heartbeats) re-arms. Long but live
// generations must complete; silent providers are still abandoned, and that
// router abort converts the dispatched OPEN per ADR 0008 (2026-11-09).
// Real Express + authenticateUser + forwardChat over a test-owned file SQLite;
// synthetic fetch only. The default-suite entry re-runs this file in a child
// with a scratch cwd (no .env: src/config/env.ts calls dotenv.config()) and an
// explicit environment. A JS guard is not an OS sandbox.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
const requireFromHere = createRequire(import.meta.url);

const ISOLATED = process.env.SHAREAI_TIMEOUTS_ISOLATED === '1';
const EXPECTED_PASS = 12;

if (!ISOLATED) {
  test('inference timeouts (isolated child)', {timeout:150000}, async () => {
    const tmp = process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : os.tmpdir();
    const cwd = mkdtempSync(path.join(tmp, 'inference-timeouts-cwd-'));
    try {
      const self = fileURLToPath(import.meta.url);
      const loader = pathToFileURL(path.join(path.dirname(self), '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
      const env = {SHAREAI_TIMEOUTS_ISOLATED:'1', TMPDIR:tmp};
      for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir']) if (process.env[name]) env[name] = process.env[name];
      const child = spawn(process.execPath, ['--import', loader, '--test', '--test-reporter=spec', self], {cwd, env, stdio:['ignore', 'pipe', 'pipe']});
      let output = '';
      child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
      const timer = setTimeout(() => child.kill(), 140000);
      const [code] = await once(child, 'close'); clearTimeout(timer);
      const summary = output.split(/\r?\n/).filter(line => /^(✔|✖|ℹ (tests|pass|fail))/.test(line)).join('\n');
      assert.equal(code, 0, summary);
      assert.match(output, /^ℹ fail 0$/m);
      assert.match(output, new RegExp(`^ℹ pass ${EXPECTED_PASS}$`, 'm'));
    } finally { rmSync(cwd, {recursive:true, force:true}); }
  });
} else {
  assert.equal(existsSync(path.join(process.cwd(), '.env')), false, 'isolated child must not see a .env');
  const {default: express} = await import('express');
  const dir = mkdtempSync(path.join(process.cwd(), 'inference-timeouts-db-'));
  const file = path.join(dir, 'db.sqlite');
  Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'});
  // Scaled limits: first response 800ms, idle 2400ms. A legacy whole-request
  // timer (120000ms) is scaled to 3200ms so the old policy is observable too.
  // Elapsed times are measured from the synthetic fetch call, excluding auth and admission.
  const FIRST = 800, IDLE = 2400, LEGACY_TOTAL = 3200;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 120000 ? LEGACY_TOTAL : ms, ...args);
  await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
  const {getDb, closeDatabase, initDatabase} = await import('../src/db/client.ts');
  initDatabase();
  const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
  const {UserRepository} = await import('../src/db/repositories/users.ts');
  const {hashApiKey, CredentialVault} = await import('../src/utils/encryption.ts');
  const {authenticateUser} = await import('../src/auth/user-auth.ts');
  const forwardModule = await import('../src/upstream/forward-chat.ts');
  const {forwardChat} = forwardModule;
  if (forwardModule.INFERENCE_TIMEOUTS) Object.assign(forwardModule.INFERENCE_TIMEOUTS, {firstResponseMs:FIRST, idleMs:IDLE});
  const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
  const {responseStream} = await import('./phase4-protocol-fixtures.mjs');
  const db = getDb(), repo = new AccountRepository();
  new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'), name:'fixture', email:'fixture@example.invalid', tier:'pro', dailyLimit:1000});
  let handling; const app = express(); app.use(express.json());
  // Optional per-test hook between authentication and forwardChat (e.g. take a DB lock).
  let beforeForward;
  app.post('/v1/chat/completions', authenticateUser, (req, res) => { handling = (async () => { if (beforeForward) await beforeForward(); return forwardChat(req, res); })(); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const nativeFetch = globalThis.fetch;
  after(async () => { globalThis.fetch = nativeFetch; globalThis.setTimeout = realSetTimeout; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); rmSync(dir, {recursive:true, force:true}); });

  const accounts = [];
  const create = name => { const a = repo.create({name, provider:'openai', credentialType:'api_key', credentials:`sk-${name}`, priority:0}); accounts.push(a); return a; };
  const isolate = (...keep) => { for (const a of accounts) if (!keep.includes(a)) repo.update(a.id, {status:'disabled'}); };
  const open = id => db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(id);
  const restriction = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);
  const bounded = (promise, ms, label) => { let t; return Promise.race([promise, new Promise((_, reject) => { t = realSetTimeout(() => reject(Error(`${label} deadline`)), ms); })]).finally(() => clearTimeout(t)); };
  const sleep = ms => new Promise(r => realSetTimeout(r, ms));
  const enc = new TextEncoder();
  const delta = text => `data: {"id":"x","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`;
  const complete = 'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  // Emits frames with a gap before each; never closes if `end` is false.
  // `cancelled` records that the router propagated cancellation to the provider body.
  let cancelled = false;
  const paced = (frames, gap, signal, end = true) => new ReadableStream({async start(c) {
    for (const f of frames) { await sleep(gap); if (signal.aborted || cancelled) return; c.enqueue(enc.encode(f)); }
    if (end) c.close();
  }, cancel() { cancelled = true; }});
  const sse = body => new Response(body, {headers:{'content-type':'text/event-stream'}});
  function request({stream = true} = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/chat/completions', method:'POST',
        headers:{authorization:'Bearer fixture-key', 'content-type':'application/json'}}, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({status:res.statusCode, text}));
        res.on('error', () => resolve({aborted:true, text}));
      });
      req.on('error', reject);
      req.end(JSON.stringify({model:'gpt-5', stream, messages:[{role:'user', content:'hello'}], router_options:{strategy:'priority'}}));
    });
  }
  let provider; let dispatchedAt;
  let fetches = 0;
  globalThis.fetch = async (url, opts) => { fetches++; dispatchedAt = performance.now(); cancelled = false; return provider(url, opts); };
  const elapsedSinceDispatch = () => performance.now() - dispatchedAt;
  const assertConverted = a => {
    assert.equal(open(a.id), undefined, 'OPEN converted');
    assert.equal(Number(restriction(a.id)?.duration_ms), 60000, '60s restriction armed');
  };

  test('a long stream with steady provider bytes outlives the old whole-request limit', {timeout:25000}, async () => {
    const a = create('long-stream'); isolate(a);
    const frames = Array.from({length:24}, (_, i) => delta(`t${i}`)).concat(complete);
    provider = async (_u, o) => sse(paced(frames, 150, o.signal));
    const r = await bounded(request(), 12000, 'request');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('[DONE]'), 'completed stream');
    for (let i = 0; i < 24; i++) assert.ok(r.text.includes(`t${i}`));
    await bounded(handling, 3000, 'handler');
    assert.equal(open(a.id), undefined); assert.equal(restriction(a.id), undefined);
  });

  test('SSE comment heartbeats keep a quiet generation alive past the idle limit', {timeout:25000}, async () => {
    const a = create('heartbeat'); isolate(a);
    const frames = [delta('start'), ...Array.from({length:20}, () => ': keepalive\n\n'), delta('end'), complete];
    provider = async (_u, o) => sse(paced(frames, 150, o.signal));
    const r = await bounded(request(), 12000, 'request');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('end') && r.text.includes('[DONE]'));
    await bounded(handling, 3000, 'handler');
    assert.equal(open(a.id), undefined); assert.equal(restriction(a.id), undefined);
  });

  test('a long non-stream generation with steady bytes completes', {timeout:25000}, async () => {
    const a = create('long-json'); isolate(a);
    const frames = Array.from({length:24}, (_, i) => delta(`n${i}`)).concat(complete);
    provider = async (_u, o) => sse(paced(frames, 150, o.signal));
    const r = await bounded(request({stream:false}), 12000, 'request');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).choices[0].message.content, Array.from({length:24}, (_, i) => `n${i}`).join(''));
    await bounded(handling, 3000, 'handler');
  });

  test('headers that arrive within the first-response limit are accepted', {timeout:25000}, async () => {
    const a = create('slow-headers'); isolate(a);
    provider = async () => { await sleep(FIRST / 2); return sse(delta('late') + complete); };
    const r = await bounded(request({stream:false}), 8000, 'request');
    assert.equal(r.status, 200);
    await bounded(handling, 3000, 'handler');
  });

  test('no response headers: aborted at the first-response limit and the OPEN is converted', {timeout:25000}, async () => {
    const a = create('no-headers'); isolate(a); const before = fetches;
    provider = (_u, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason), {once:true}));
    const r = await bounded(request({stream:false}), 8000, 'request');
    const elapsed = elapsedSinceDispatch();
    assert.notEqual(r.status, 200);
    assert.ok(elapsed >= FIRST - 50 && elapsed < IDLE - 300, `first-response abort at ${Math.round(elapsed)}ms`);
    assert.equal(fetches, before + 1, 'a single dispatch');
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
  });

  test('silence after headers: aborted at the idle limit and the OPEN is converted', {timeout:25000}, async () => {
    const a = create('idle'); isolate(a);
    provider = async (_u, o) => sse(paced([delta('partial')], 0, o.signal, false));
    const r = await bounded(request(), 8000, 'request');
    const elapsed = elapsedSinceDispatch();
    assert.ok(r.aborted || !r.text.includes('[DONE]'), 'an abandoned stream must not report completion');
    assert.ok(elapsed >= IDLE - 50 && elapsed < LEGACY_TOTAL - 200, `idle abort at ${Math.round(elapsed)}ms`);
    await bounded(handling, 3000, 'handler');
    assert.equal(cancelled, true, 'provider body cancelled');
    assertConverted(a);
  });

  test('a 401 refresh retry gets a fresh first-response limit for its own dispatch', {timeout:25000}, async () => {
    const credentials = JSON.stringify({kind:'oauth', accessToken:'initial', refreshToken:'fixture-refresh', expiresAt:Date.now() + 3_600_000, accountId:'workspace'});
    const a = repo.create({name:'oauth-retry', provider:'openai', credentialType:'oauth', credentials, priority:0}); accounts.push(a); isolate(a);
    // dispatch 1: 401 after 0.7 FIRST; refresh takes 0.6 FIRST; dispatch 2: headers after 0.7 FIRST.
    // Only a limit re-armed at each dispatch admits the second response.
    const seen = [];
    provider = async (url, o) => {
      if (String(url).includes('oauth/token')) { seen.push('refresh'); await sleep(FIRST * 0.6); return new Response(JSON.stringify({access_token:'rotated', refresh_token:'fixture-refresh-2', expires_in:3600})); }
      seen.push(o.headers.authorization);
      await sleep(FIRST * 0.7);
      if (o.headers.authorization === 'Bearer initial') return new Response('', {status:401});
      return sse(responseStream);
    };
    const r = await bounded(request(), 12000, 'request');
    assert.deepEqual(seen, ['Bearer initial', 'refresh', 'Bearer rotated']);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.includes('[DONE]'));
    await bounded(handling, 3000, 'handler');
    assert.equal(open(a.id), undefined); assert.equal(restriction(a.id), undefined);
  });

  test('silence in a non-stream generation is aborted at the idle limit and the OPEN is converted', {timeout:25000}, async () => {
    const a = create('idle-json'); isolate(a);
    provider = async (_u, o) => sse(paced([delta('partial')], 0, o.signal, false));
    const r = await bounded(request({stream:false}), 8000, 'request');
    const elapsed = elapsedSinceDispatch();
    assert.notEqual(r.status, 200);
    assert.ok(elapsed >= IDLE - 50 && elapsed < LEGACY_TOTAL - 200, `non-stream idle abort at ${Math.round(elapsed)}ms`);
    await bounded(handling, 3000, 'handler');
    assert.equal(cancelled, true, 'provider body cancelled');
    assertConverted(a);
  });

  test('a refresh outlasting the first-response limit never dispatches or restricts the retry', {timeout:25000}, async () => {
    const credentials = JSON.stringify({kind:'oauth', accessToken:'initial-slow', refreshToken:'fixture-refresh-slow', expiresAt:Date.now() + 3_600_000, accountId:'workspace'});
    const a = repo.create({name:'oauth-slow-refresh', provider:'openai', credentialType:'oauth', credentials, priority:0}); accounts.push(a); isolate(a);
    const seen = [];
    provider = async (url, o) => {
      if (String(url).includes('oauth/token')) { seen.push('refresh'); await sleep(FIRST * 2); return new Response(JSON.stringify({access_token:'rotated-slow', refresh_token:'fixture-refresh-slow-2', expires_in:3600})); }
      seen.push(o.headers.authorization);
      return o.headers.authorization === 'Bearer initial-slow' ? new Response('', {status:401}) : sse(responseStream);
    };
    const r = await bounded(request(), 12000, 'request');
    await bounded(handling, 3000, 'handler');
    assert.notEqual(r.status, 200);
    assert.deepEqual(seen, ['Bearer initial-slow', 'refresh'], 'the retry is never dispatched');
    assert.equal(open(a.id), undefined, 'no OPEN left behind');
    assert.equal(restriction(a.id), undefined, 'an undispatched retry is not restricted');
    // The abandoned refresh still completes and persists its rotation for the next request.
    await sleep(FIRST * 2);
    const next = await bounded(request({stream:false}), 8000, 'next request');
    assert.equal(next.status, 200, next.text);
    assert.deepEqual(seen, ['Bearer initial-slow', 'refresh', 'Bearer rotated-slow'], 'rotation kept; no second refresh');
    assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken, 'fixture-refresh-slow-2');
  });

  test('a writer lock outlasting the first-response limit aborts before dispatch with no OPEN or restriction', {timeout:25000}, async () => {
    const a = create('writer-locked'); isolate(a);
    provider = async () => sse(delta('never') + complete);
    // A separate connection holds the SQLite write lock; the router's writer retries
    // asynchronously, so its own timer can fire while it waits.
    const worker = new Worker(`const {parentPort, workerData} = require('node:worker_threads');
      const Database = require(workerData.mod); const db = new Database(workerData.file, {timeout:0});
      parentPort.on('message', m => { if (m === 'lock') { db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked'); } else { db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released'); } });`,
      {eval:true, workerData:{mod:requireFromHere.resolve('better-sqlite3'), file}});
    try {
      beforeForward = async () => { worker.postMessage('lock'); await once(worker, 'message'); };
      const before = fetches, started = performance.now();
      const r = await bounded(request({stream:false}), 8000, 'request');
      const elapsed = performance.now() - started;
      await bounded(handling, 3000, 'handler');
      assert.notEqual(r.status, 200);
      assert.equal(fetches, before, 'never dispatched');
      assert.ok(elapsed >= FIRST - 50 && elapsed < FIRST + 800, `aborted at ${Math.round(elapsed)}ms: the first-response limit, not idle, legacy or the writer's 5s timeout`);
    } finally {
      beforeForward = undefined;
      worker.postMessage('release'); await once(worker, 'message'); await worker.terminate();
    }
    assert.equal(open(a.id), undefined, 'no OPEN left behind');
    assert.equal(restriction(a.id), undefined, 'no restriction');
  });

  // SIWC accounts share the same watchdog. Ordinary accounts are disabled.
  db.exec('CREATE TABLE IF NOT EXISTS siwc_accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const siwcIds = [];
  const createSiwc = id => {
    for (const other of siwcIds) db.prepare('UPDATE siwc_access_policy SET enabled=0 WHERE account_id=?').run(other);
    siwcIds.push(id);
    db.prepare('INSERT INTO siwc_accounts VALUES (?, ?)').run(id, id);
    db.prepare("INSERT INTO siwc_access_policy VALUES (?, 1, 'all')").run(id);
    db.prepare('INSERT INTO siwc_routing_settings(account_id, priority, weight) VALUES (?, 0, 1)').run(id);
    new SiwcStore(db, new CredentialVault()).create(id, {issuer:'https://auth.openai.com', subject:`synthetic-${id}`, clientId:`fixture-${id}`, accessToken:'fixture-access', idToken:'fixture-id', tokenType:'Bearer', expiresIn:3600, scopes:['chatgpt.tokens.use.direct'], savedAt:new Date().toISOString()});
  };
  const siwcOpen = id => db.prepare('SELECT 1 FROM siwc_account_attempts WHERE account_id=?').get(id);
  const siwcRestriction = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id=?").get(id);
  const siwcFrames = responseStream.split('\n\n').filter(Boolean).map(f => f + '\n\n');

  test('SIWC: a paced Responses stream outlives the old whole-request limit', {timeout:25000}, async () => {
    isolate(); createSiwc('siwc-long');
    const gap = Math.ceil((LEGACY_TOTAL + 400) / siwcFrames.length);
    assert.ok(gap < IDLE - 300);
    provider = async (_u, o) => sse(paced(siwcFrames, gap, o.signal));
    const r = await bounded(request(), 12000, 'request');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('[DONE]'));
    await bounded(handling, 3000, 'handler');
    assert.equal(siwcOpen('siwc-long'), undefined); assert.equal(siwcRestriction('siwc-long'), undefined);
  });

  test('SIWC: silence after headers is aborted at the idle limit and its OPEN is converted', {timeout:25000}, async () => {
    isolate(); createSiwc('siwc-idle');
    provider = async (_u, o) => sse(paced(siwcFrames.slice(0, 3), 0, o.signal, false));
    const r = await bounded(request(), 8000, 'request');
    const elapsed = elapsedSinceDispatch();
    assert.ok(r.aborted || !r.text.includes('[DONE]'));
    assert.ok(elapsed >= IDLE - 50 && elapsed < LEGACY_TOTAL - 200, `SIWC idle abort at ${Math.round(elapsed)}ms`);
    await bounded(handling, 3000, 'handler');
    assert.equal(cancelled, true, 'SIWC provider body cancelled');
    assert.equal(siwcOpen('siwc-idle'), undefined, 'SIWC OPEN converted');
    assert.equal(Number(siwcRestriction('siwc-idle')?.duration_ms), 60000);
  });
}
