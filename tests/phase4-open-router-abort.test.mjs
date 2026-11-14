// ADR 0008 amendments (2026-11-09, 2026-11-13) / ADR 0016 item 4: a dispatched attempt
// that ends without a provider terminal converts its OPEN into a 60s v2 restriction when
// the router itself aborted it (client disconnect, inference timer) or when the provider
// exchange visibly ended (network failure, unreadable or broken 2xx response). A dispatch
// whose transport outcome was never observed and any uncertain settlement keep the
// indefinite OPEN.
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

const ISOLATED = process.env.SHAREAI_OPEN_ABORT_ISOLATED === '1';

if (!ISOLATED) {
  test('router-initiated abort settlement (isolated child)', {timeout:60000}, async () => {
    const tmp = process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : os.tmpdir();
    const cwd = mkdtempSync(path.join(tmp, 'open-abort-cwd-'));
    try {
      const self = fileURLToPath(import.meta.url);
      const loader = pathToFileURL(path.join(path.dirname(self), '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
      const env = {SHAREAI_OPEN_ABORT_ISOLATED:'1', TMPDIR:tmp};
      for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir']) if (process.env[name]) env[name] = process.env[name];
      const child = spawn(process.execPath, ['--import', loader, '--test', '--test-reporter=spec', self], {cwd, env, stdio:['ignore', 'pipe', 'pipe']});
      let output = '';
      child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
      const timer = setTimeout(() => child.kill(), 50000);
      const [code] = await once(child, 'close'); clearTimeout(timer);
      // Fixed diagnostics only; the child uses synthetic values but output is not echoed wholesale.
      const summary = output.split(/\r?\n/).filter(line => /^(✔|✖|ℹ (tests|pass|fail))/.test(line)).join('\n');
      assert.equal(code, 0, summary);
      assert.match(output, /^ℹ fail 0$/m);
      assert.match(output, /^ℹ pass 22$/m);
    } finally { rmSync(cwd, {recursive:true, force:true}); }
  });
} else {
  assert.equal(existsSync(path.join(process.cwd(), '.env')), false, 'isolated child must not see a .env');
  const {default: express} = await import('express');
  const {default: Database} = await import('better-sqlite3');
  // Under the parent's owned cwd, so a killed child's files are removed with it.
  const dir = mkdtempSync(path.join(process.cwd(), 'open-abort-db-'));
  const file = path.join(dir, 'db.sqlite');
  Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'});
  const realSetTimeout = globalThis.setTimeout;
  { const raw = new Database(file); const {provisionFreshSafetySchema} = await import('../src/db/client.ts'); raw.transaction(() => provisionFreshSafetySchema(raw)).immediate(); raw.close(); }
  const {getDb, closeDatabase, initDatabase} = await import('../src/db/client.ts');
  initDatabase();
  const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
  const {UserRepository} = await import('../src/db/repositories/users.ts');
  const {hashApiKey} = await import('../src/utils/encryption.ts');
  const {authenticateUser} = await import('../src/auth/user-auth.ts');
  const {forwardChat, INFERENCE_TIMEOUTS} = await import('../src/upstream/forward-chat.ts');
  // Shrink the router's own inference limits (ADR 0016 item 3) so its abort path is observable.
  Object.assign(INFERENCE_TIMEOUTS, {firstResponseMs:150, idleMs:150});
  const {CredentialVault} = await import('../src/utils/encryption.ts');
  const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
  // All asynchronous setup precedes test registration so the after() hook cannot run early.
  const db = getDb(), repo = new AccountRepository();
  new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'), name:'fixture', email:'fixture@example.invalid', tier:'pro', dailyLimit:1000});
  let handling; const app = express(); app.use(express.json());
  app.post('/v1/chat/completions', authenticateUser, (req, res) => { handling = forwardChat(req, res); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  assert.notEqual(server.address().port, 20128);
  const nativeFetch = globalThis.fetch;
  after(async () => { globalThis.fetch = nativeFetch; globalThis.setTimeout = realSetTimeout; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); rmSync(dir, {recursive:true, force:true}); });

  const accounts = [];
  const create = (name, priority = 0) => { const a = repo.create({name, provider:'openai', credentialType:'api_key', credentials:`sk-${name}`, priority}); accounts.push(a); return a; };
  const isolate = (...keep) => { for (const a of accounts) if (!keep.includes(a)) repo.update(a.id, {status:'disabled'}); };
  const open = id => db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(id);
  const restriction = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);
  const bounded = (promise, ms, label) => { let t; return Promise.race([promise, new Promise((_, reject) => { t = realSetTimeout(() => reject(Error(`${label} deadline`)), ms); })]).finally(() => clearTimeout(t)); };
  const delta = text => `data: {"id":"x","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`;
  const complete = 'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  // stream=true request; abort: 'first-chunk' | Promise (disconnect when it resolves) | undefined.
  function request({stream = true, abort} = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/chat/completions', method:'POST',
        headers:{authorization:'Bearer fixture-key', 'content-type':'application/json'}}, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; if (abort === 'first-chunk') { req.destroy(); resolve({aborted:true}); } });
        res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text}));
        res.on('error', () => resolve({aborted:true}));
      });
      req.on('error', error => abort ? resolve({aborted:true}) : reject(error));
      if (abort instanceof Promise) abort.then(() => req.destroy());
      req.end(JSON.stringify({model:'gpt-5', stream, messages:[{role:'user', content:'hello'}], router_options:{strategy:'priority'}}));
    });
  }
  const calls = [];
  let mode;
  let dispatched; const nextDispatch = () => new Promise(r => { dispatched = r; });
  const {responseStream} = await import('./phase4-protocol-fixtures.mjs');
  // Header, created … first delta of a Responses lifecycle, then nothing more.
  const siwcPartial = responseStream.split('\n\n').slice(0, 5).join('\n\n') + '\n\n';
  const sse = {'content-type':'text/event-stream'};
  // Not async: 'sync-throw' fails inside the dispatch step itself, before any transport outcome exists.
  globalThis.fetch = (url, opts) => {
    if (mode === 'sync-throw') { calls.push('sync-throw'); throw new TypeError('synthetic dispatch failure'); }
    return respond(url, opts);
  };
  const respond = async (url, opts) => {
    if (String(url).endsWith('/v1/responses')) {
      calls.push('siwc'); dispatched?.();
      if (mode === 'network') throw new TypeError('synthetic network failure');
      if (mode === 'truncated') return new Response(siwcPartial, {headers:sse});
      if (mode === 'wrong-type') return new Response('<html>synthetic</html>', {headers:{'content-type':'text/html'}});
      if (mode === 'body-reset') {
        let sent = false;
        return new Response(new ReadableStream({pull(c) { if (sent) c.error(new TypeError('synthetic reset')); else { sent = true; c.enqueue(new TextEncoder().encode(siwcPartial)); } }}), {headers:sse});
      }
      if (mode === 'complete') return new Response(responseStream, {headers:sse});
      return new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(siwcPartial)); }}), {headers:{'content-type':'text/event-stream'}});
    }
    calls.push(opts.headers.authorization); dispatched?.();
    if (mode === 'complete') return new Response(delta('ok') + complete, {headers:{'content-type':'text/event-stream'}});
    if (mode === 'network') throw new TypeError('synthetic network failure');
    if (mode === 'truncated') return new Response(delta('partial'), {headers:sse});
    if (mode === 'wrong-type') return new Response('<html>synthetic</html>', {headers:{'content-type':'text/html'}});
    if (mode === 'body-reset') {
      let sent = false;
      return new Response(new ReadableStream({pull(c) { if (sent) c.error(new TypeError('synthetic reset')); else { sent = true; c.enqueue(new TextEncoder().encode(delta('partial'))); } }}), {headers:sse});
    }
    if (mode === 'no-headers') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), {once:true}));
    // 'hang': headers and one delta, then the generation never finishes.
    return new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(delta('partial'))); }}), {headers:{'content-type':'text/event-stream'}});
  };
  const followUpBlocked = async a => {
    const before = calls.length;
    const r = await bounded(request({stream:false}), 3000, 'follow-up');
    assert.equal(r.status, 429, 'restricted account is not selected; the client is told to wait (ADR 0019 item 8)');
    assert.equal(r.headers['retry-after'], '60', 'the 60s rest is announced');
    assert.equal(calls.length, before, 'follow-up must not reach the provider');
    assert.ok(restriction(a.id));
  };
  const assertConverted = a => {
    assert.equal(open(a.id), undefined, 'OPEN converted');
    assert.equal(Number(restriction(a.id)?.duration_ms), 60000, '60s restriction armed');
  };

  test('client disconnect after headers converts the OPEN into a 60s restriction', {timeout:10000}, async () => {
    const a = create('after-headers'); isolate(a); mode = 'hang';
    await bounded(request({abort:'first-chunk'}), 3000, 'request');
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
    await followUpBlocked(a);
  });

  test('client disconnect before headers also converts the OPEN', {timeout:10000}, async () => {
    const a = create('before-headers'); isolate(a); mode = 'no-headers';
    const fired = nextDispatch();
    await bounded(request({abort:fired}), 3000, 'request');
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
    await followUpBlocked(a);
  });

  test('router inference timer abort mid-stream converts the OPEN', {timeout:10000}, async () => {
    const a = create('timer'); isolate(a); mode = 'hang';
    const r = await bounded(request(), 3000, 'request');
    // The router destroys the response after its own abort; it must never report completion.
    assert.ok(r.aborted || !r.text.includes('[DONE]'), 'an aborted stream must not report completion');
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
    await followUpBlocked(a);
  });

  test('router timer abort before response headers converts the OPEN', {timeout:10000}, async () => {
    const a = create('timer-no-headers'); isolate(a); mode = 'no-headers';
    const r = await bounded(request(), 3000, 'request');
    assert.notEqual(r.status, 200);
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
    await followUpBlocked(a);
  });

  test('after A is aborted, a new request is served by B', {timeout:10000}, async () => {
    const a = create('switch-a'), b = create('switch-b', 10); isolate(a, b); mode = 'hang';
    await bounded(request({abort:'first-chunk'}), 3000, 'request');
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
    mode = 'complete'; const before = calls.length;
    const r = await bounded(request({stream:false}), 3000, 'follow-up');
    assert.equal(r.status, 200);
    assert.deepEqual(calls.slice(before), ['Bearer sk-switch-b']);
    assert.equal(open(b.id), undefined);
  });

  // ADR 0008 (2026-11-13). Long router limits: these must end through the provider failure, not a router timer.
  const providerFailure = async fn => {
    const saved = {...INFERENCE_TIMEOUTS};
    Object.assign(INFERENCE_TIMEOUTS, {firstResponseMs:5000, idleMs:5000});
    try { await fn(); } finally { Object.assign(INFERENCE_TIMEOUTS, saved); }
  };
  for (const [label, failure] of [['a network failure before response headers', 'network'], ['a stream that ends without a terminal', 'truncated'], ['an unreadable 2xx response', 'wrong-type'], ['a connection reset while reading the body', 'body-reset']]) {
    test(`${label} converts the OPEN into a 60s restriction`, {timeout:10000}, () => providerFailure(async () => {
      const a = create(`provider-${failure}`); isolate(a); mode = failure;
      const before = calls.length;
      const r = await bounded(request({stream:false}), 3000, 'request');
      assert.equal(r.status, 502, 'a provider failure, not a router timeout');
      await bounded(handling, 3000, 'handler');
      assert.equal(calls.length, before + 1, 'the request is never sent again');
      assertConverted(a);
      await followUpBlocked(a);
    }));
  }

  test('after a provider failure on A, a new request is served by B', {timeout:10000}, () => providerFailure(async () => {
    const a = create('failed-a'), b = create('failed-b', 10); isolate(a, b); mode = 'network';
    assert.equal((await bounded(request({stream:false}), 3000, 'request')).status, 502);
    await bounded(handling, 3000, 'handler');
    assertConverted(a);
    mode = 'complete'; const before = calls.length;
    assert.equal((await bounded(request({stream:false}), 3000, 'follow-up')).status, 200);
    assert.deepEqual(calls.slice(before), ['Bearer sk-failed-b']);
  }));

  test('a dispatch whose transport outcome was never observed keeps the indefinite OPEN', {timeout:10000}, () => providerFailure(async () => {
    const a = create('unobserved'); isolate(a); mode = 'sync-throw';
    const before = calls.length;
    const r = await bounded(request({stream:false}), 3000, 'request');
    assert.equal(r.status, 502);
    await bounded(handling, 3000, 'handler');
    assert.deepEqual(calls.slice(before), ['sync-throw']);
    assert.ok(open(a.id), 'conservative OPEN retained');
    assert.equal(restriction(a.id), undefined, 'no restriction substituted');
  }));

  // Settlement deletes the OPEN in the same transaction that arms a restriction. 'every' denies
  // each delete; 'plain' denies only a delete that armed nothing first, so a conversion would commit.
  const denyingSettlement = async (which, fn, kind = 'upstream') => {
    const unarmed = which === 'plain' ? ` WHEN NOT EXISTS (SELECT 1 FROM account_429_v2_restrictions WHERE kind='${kind}' AND account_id=OLD.account_id)` : '';
    db.exec(`CREATE TRIGGER test_deny_settle BEFORE DELETE ON ${kind === 'siwc' ? 'siwc' : 'ordinary'}_account_attempts${unarmed} BEGIN SELECT RAISE(ABORT,'denied'); END`);
    try { await fn(); } finally { db.exec('DROP TRIGGER test_deny_settle'); }
  };
  test('an uncertain conversion after a provider failure keeps the OPEN and arms nothing', {timeout:10000}, () => providerFailure(() => denyingSettlement('every', async () => {
    const a = create('conversion-fails'); isolate(a); mode = 'network';
    assert.equal((await bounded(request({stream:false}), 3000, 'request')).status, 502);
    await bounded(handling, 3000, 'handler');
    assert.ok(open(a.id), 'OPEN retained');
    assert.equal(restriction(a.id), undefined, 'the arm rolled back with the denied delete');
  })));

  test('a failed settlement after the provider terminal is not converted', {timeout:10000}, () => providerFailure(() => denyingSettlement('plain', async () => {
    const a = create('settle-fails'); isolate(a); mode = 'complete';
    const before = calls.length;
    assert.notEqual((await bounded(request({stream:false}), 3000, 'request')).status, 200, 'an unsettled completion is not reported as success');
    await bounded(handling, 3000, 'handler');
    assert.deepEqual(calls.slice(before), ['Bearer sk-settle-fails'], 'the provider completed the request');
    assert.ok(open(a.id), 'OPEN retained');
    assert.equal(restriction(a.id), undefined, 'a settlement failure is not a provider failure');
  })));

  // SIWC accounts: same policy through settleSiwc. Ordinary accounts are disabled.
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

  test('SIWC client disconnect after dispatch converts its OPEN into a 60s restriction', {timeout:10000}, async () => {
    isolate(); createSiwc('siwc-abort'); mode = 'hang';
    const before = calls.length;
    await bounded(request({abort:'first-chunk'}), 3000, 'request');
    await bounded(handling, 3000, 'handler');
    assert.deepEqual(calls.slice(before), ['siwc'], 'SIWC account was dispatched');
    assert.equal(siwcOpen('siwc-abort'), undefined, 'SIWC OPEN converted');
    assert.equal(Number(siwcRestriction('siwc-abort')?.duration_ms), 60000, '60s SIWC restriction armed');
  });

  test('SIWC dispatch whose transport outcome was never observed keeps the indefinite OPEN', {timeout:10000}, () => providerFailure(async () => {
    isolate(); createSiwc('siwc-unobserved'); mode = 'sync-throw';
    const before = calls.length;
    assert.notEqual((await bounded(request({stream:false}), 3000, 'request')).status, 200);
    await bounded(handling, 3000, 'handler');
    assert.deepEqual(calls.slice(before), ['sync-throw']);
    assert.ok(siwcOpen('siwc-unobserved'), 'conservative SIWC OPEN retained');
    assert.equal(siwcRestriction('siwc-unobserved'), undefined);
  }));

  for (const failure of ['network', 'truncated', 'wrong-type', 'body-reset']) {
    test(`SIWC provider failure after dispatch (${failure}) converts its OPEN into a 60s restriction`, {timeout:10000}, () => providerFailure(async () => {
      const id = `siwc-${failure}`;
      isolate(); createSiwc(id); mode = failure;
      const before = calls.length;
      const r = await bounded(request({stream:false}), 3000, 'request');
      assert.equal(r.status, 502, 'a provider failure, not a router timeout');
      await bounded(handling, 3000, 'handler');
      assert.deepEqual(calls.slice(before), ['siwc']);
      assert.equal(siwcOpen(id), undefined, 'SIWC OPEN converted');
      assert.equal(Number(siwcRestriction(id)?.duration_ms), 60000, '60s SIWC restriction armed');
    }));
  }

  test('SIWC: an uncertain conversion after a provider failure keeps the OPEN and arms nothing', {timeout:10000}, () => providerFailure(() => denyingSettlement('every', async () => {
    isolate(); createSiwc('siwc-conversion-fails'); mode = 'network';
    assert.equal((await bounded(request({stream:false}), 3000, 'request')).status, 502);
    await bounded(handling, 3000, 'handler');
    assert.ok(siwcOpen('siwc-conversion-fails'), 'SIWC OPEN retained');
    assert.equal(siwcRestriction('siwc-conversion-fails'), undefined, 'the arm rolled back with the denied delete');
  }, 'siwc')));

  test('SIWC: a failed settlement after the provider terminal is not converted', {timeout:10000}, () => providerFailure(() => denyingSettlement('plain', async () => {
    isolate(); createSiwc('siwc-settle-fails'); mode = 'complete';
    const before = calls.length;
    assert.notEqual((await bounded(request({stream:false}), 3000, 'request')).status, 200, 'an unsettled completion is not reported as success');
    await bounded(handling, 3000, 'handler');
    assert.deepEqual(calls.slice(before), ['siwc'], 'the provider completed the request');
    assert.ok(siwcOpen('siwc-settle-fails'), 'SIWC OPEN retained');
    assert.equal(siwcRestriction('siwc-settle-fails'), undefined, 'a settlement failure is not a provider failure');
  }, 'siwc')));

  test('SIWC router timer abort mid-stream converts its OPEN', {timeout:10000}, async () => {
    isolate(); createSiwc('siwc-timer'); mode = 'hang';
    const before = calls.length;
    const r = await bounded(request(), 3000, 'request');
    assert.ok(r.aborted || !r.text.includes('[DONE]'));
    await bounded(handling, 3000, 'handler');
    assert.deepEqual(calls.slice(before), ['siwc']);
    assert.equal(siwcOpen('siwc-timer'), undefined, 'SIWC OPEN converted');
    assert.equal(Number(siwcRestriction('siwc-timer')?.duration_ms), 60000);
  });
}
