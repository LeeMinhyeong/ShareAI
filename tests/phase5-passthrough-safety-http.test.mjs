// Phase 5 (ADR 0019) completion item 3: the passthrough endpoints inherit the
// Phase 4 safety properties of the shared pipeline. Real Express + v1 router
// over a test-owned file SQLite; synthetic fetch only.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';

Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(24), LOG_LEVEL:'error', LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const {initDatabase, closeDatabase, getDb} = await import('../src/db/client.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
const {captureRawBody, JSON_BODY_LIMIT} = await import('../src/http/raw-body.ts');
const {INFERENCE_TIMEOUTS, ROUTER_ABORT_RESTRICTION_MS} = await import('../src/upstream/forward-chat.ts');
const {requestWork} = await import('../src/request-work.ts');
const {default: router} = await import('../src/routes/v1.ts');
initDatabase();
const db = getDb();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('safe-key'), name:'safe', email:'safe@example.invalid', tier:'pro', dailyLimit:1000});
users.create({apiKeyHash:hashApiKey('one-key'), name:'one', email:'one@example.invalid', tier:'free', dailyLimit:1});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', router);
const server = http.createServer(app);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
assert.notEqual(server.address().port, 20128);
const nativeFetch = globalThis.fetch, defaults = {...INFERENCE_TIMEOUTS};
after(async () => { globalThis.fetch = nativeFetch; Object.assign(INFERENCE_TIMEOUTS, defaults); server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); });

const accounts = [];
function account(spec) {
  for (const a of accounts) repo.update(a.id, {status:'disabled'});
  const a = repo.create(spec); accounts.push(a); return a;
}
const anthropicKey = name => account({name, provider:'anthropic', credentialType:'api_key', credentials:`sk-ant-api03-${name}`});
const anthropicOauth = name => account({name, provider:'anthropic', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:`old-${name}`, refreshToken:`ort-${name}`, expiresAt:Date.now() + 3600_000})});
const openaiKey = name => account({name, provider:'openai', credentialType:'api_key', credentials:`sk-${name}`});
const open = id => db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(id);
const restriction = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);

const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const start = ev('message_start', {type:'message_start', message:{id:'msg_s', type:'message', role:'assistant', content:[], usage:{input_tokens:1, output_tokens:1}}});
const done = [ev('content_block_start', {type:'content_block_start', index:0, content_block:{type:'text', text:''}}), ev('content_block_delta', {type:'content_block_delta', index:0, delta:{type:'text_delta', text:'hi'}}), ev('content_block_stop', {type:'content_block_stop', index:0}), ev('message_delta', {type:'message_delta', delta:{stop_reason:'end_turn'}, usage:{output_tokens:2}}), ev('message_stop', {type:'message_stop'})];
const rev = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const rStart = rev({type:'response.created', sequence_number:0, response:{id:'resp_s', status:'in_progress'}});
const messagesBody = JSON.stringify({model:'claude-sonnet-5-5', max_tokens:100, stream:true, messages:[{role:'user', content:'hi'}]});
const responsesBody = JSON.stringify({model:'gpt-6.1-sol', input:'hi', stream:true, store:false});

const enc = new TextEncoder();
/** A held SSE body: `push` enqueues frames, `end` closes. The router's abort cancels it. */
function heldStream(initial = []) {
  let controller;
  const body = new ReadableStream({start(c) { controller = c; for (const f of initial) c.enqueue(enc.encode(f)); }, cancel() { held.cancelled = true; }});
  const held = {body, cancelled:false, push: f => controller.enqueue(enc.encode(f)), end: () => controller.close()};
  return held;
}
let calls;
function upstream(handler) { calls = []; globalThis.fetch = async (url, init) => { calls.push({url:String(url), headers:Object.fromEntries(new Headers(init?.headers).entries())}); return handler(String(url), init); }; }
function send(path, body, {key = 'safe-key', header = 'authorization', onFirstChunk} = {}) {
  return new Promise((resolve, reject) => {
    const headers = {'content-type':'application/json', 'content-length':Buffer.byteLength(body)};
    if (key) headers[header] = header === 'authorization' ? `Bearer ${key}` : key;
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method:'POST', agent:false, headers}, res => {
      let text = '', first = true;
      res.setEncoding('utf8');
      res.on('data', c => { text += c; if (first && onFirstChunk) { first = false; onFirstChunk(req); } });
      res.on('end', () => resolve({status:res.statusCode, text}));
      res.on('error', () => resolve({status:res.statusCode, text, aborted:true}));
    });
    req.on('error', e => onFirstChunk ? resolve({aborted:true}) : reject(e));
    req.end(body);
  });
}
const until = async (cond, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 10)); } };

test('auth: missing key gets an Anthropic envelope; x-api-key (ANTHROPIC_API_KEY mode) authenticates', async () => {
  anthropicKey('auth');
  upstream(() => new Response(start + done.join(''), {headers:{'content-type':'text/event-stream'}}));
  const missing = await send('/v1/messages', messagesBody, {key:null});
  assert.equal(missing.status, 401);
  const body = JSON.parse(missing.text);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'authentication_error');
  assert.equal(calls.length, 0);
  const viaHeader = await send('/v1/messages', messagesBody, {header:'x-api-key'});
  assert.equal(viaHeader.status, 200, viaHeader.text);
});

test('quota: each passthrough request reserves user quota; exhaustion is a local 429 envelope', async () => {
  anthropicKey('quota');
  upstream(() => new Response(start + done.join(''), {headers:{'content-type':'text/event-stream'}}));
  assert.equal((await send('/v1/messages', messagesBody, {key:'one-key'})).status, 200);
  const second = await send('/v1/messages', messagesBody, {key:'one-key'});
  assert.equal(second.status, 429);
  assert.equal(JSON.parse(second.text).type, 'error');
  assert.equal(calls.length, 1, 'exhausted quota never dispatches');
  const third = await send('/v1/responses', responsesBody, {key:'one-key'});
  assert.equal(third.status, 429, 'the same user quota covers /v1/responses');
});

test('Esc: a client disconnect mid-stream converts the OPEN to the router-abort restriction (messages)', async () => {
  const a = anthropicKey('esc-m');
  const held = heldStream([start]);
  upstream(() => new Response(held.body, {headers:{'content-type':'text/event-stream'}}));
  const r = await send('/v1/messages', messagesBody, {onFirstChunk: req => req.destroy()});
  assert.ok(r.aborted || r.status === 200);
  await until(() => !open(a.id) && restriction(a.id));
  assert.equal(restriction(a.id).duration_ms, ROUTER_ABORT_RESTRICTION_MS);
  await until(() => held.cancelled);
});

test('Esc: a client disconnect mid-stream converts the OPEN to the router-abort restriction (responses)', async () => {
  const a = openaiKey('esc-r');
  const held = heldStream([rStart]);
  upstream(() => new Response(held.body, {headers:{'content-type':'text/event-stream'}}));
  await send('/v1/responses', responsesBody, {onFirstChunk: req => req.destroy()});
  await until(() => !open(a.id) && restriction(a.id));
  assert.equal(restriction(a.id).duration_ms, ROUTER_ABORT_RESTRICTION_MS);
});

test('idle limit: a stalled stream ends with a router error event and the router-abort restriction', async () => {
  const a = anthropicKey('idle');
  Object.assign(INFERENCE_TIMEOUTS, {firstResponseMs:2000, idleMs:200});
  try {
    const held = heldStream([start]);
    upstream(() => new Response(held.body, {headers:{'content-type':'text/event-stream'}}));
    const r = await send('/v1/messages', messagesBody);
    assert.equal(r.status, 200);
    assert.ok(r.text.startsWith(start));
    assert.match(r.text.slice(start.length), /^event: error\ndata: \{"type":"error"/);
    await until(() => !open(a.id));
    assert.equal(restriction(a.id).duration_ms, ROUTER_ABORT_RESTRICTION_MS);
  } finally { Object.assign(INFERENCE_TIMEOUTS, defaults); }
});

test('idle limit: ping events count as progress, so a long thinking pause with pings is not cut', async () => {
  const a = anthropicKey('pings');
  Object.assign(INFERENCE_TIMEOUTS, {firstResponseMs:2000, idleMs:250});
  try {
    const held = heldStream([start]);
    upstream(() => new Response(held.body, {headers:{'content-type':'text/event-stream'}}));
    const pending = send('/v1/messages', messagesBody);
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 120)); held.push(ev('ping', {type:'ping'})); }
    for (const f of done) held.push(f); held.end();
    const r = await pending;
    assert.equal(r.status, 200);
    assert.match(r.text, /message_stop/);
    assert.doesNotMatch(r.text, /event: error/);
    assert.equal(open(a.id), undefined);
    assert.equal(restriction(a.id), undefined);
  } finally { Object.assign(INFERENCE_TIMEOUTS, defaults); }
});

test('401 refresh: a subscription token rejected with 401 is refreshed once and the request is resent', async () => {
  const a = anthropicOauth('refresh');
  const auths = [];
  upstream((url, init) => {
    if (url.includes('/oauth/token')) return new Response(JSON.stringify({access_token:'new-token', refresh_token:'ort-next', expires_in:3600, token_type:'Bearer'}), {headers:{'content-type':'application/json'}});
    auths.push(new Headers(init.headers).get('authorization'));
    if (auths.length === 1) return new Response('{"type":"error","error":{"type":"authentication_error","message":"expired"}}', {status:401, headers:{'content-type':'application/json'}});
    return new Response(start + done.join(''), {headers:{'content-type':'text/event-stream'}});
  });
  const r = await send('/v1/messages', messagesBody);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(auths, ['Bearer old-refresh', 'Bearer new-token']);
  assert.equal(calls.filter(c => c.url.includes('/oauth/token')).length, 1);
  assert.equal(open(a.id), undefined);
});

// Keep last: stopAndDrain permanently closes admission for this process.
test('shutdown: an in-flight passthrough stream completes during drain; new requests are refused', async () => {
  const a = anthropicKey('drain');
  const held = heldStream([start]);
  upstream(() => new Response(held.body, {headers:{'content-type':'text/event-stream'}}));
  const inFlight = send('/v1/messages', messagesBody);
  await until(() => calls.length === 1 && open(a.id));
  let drained = false;
  const drain = requestWork.stopAndDrain().then(() => { drained = true; });
  const refused = await send('/v1/messages', messagesBody);
  assert.equal(refused.status, 503);
  assert.equal(JSON.parse(refused.text).type, 'error');
  assert.equal(drained, false, 'drain waits for the owned stream');
  for (const f of done) held.push(f); held.end();
  const r = await inFlight;
  assert.equal(r.status, 200);
  assert.match(r.text, /message_stop/);
  await drain;
  assert.equal(open(a.id), undefined, 'settled before drain resolved');
});
