// ADR 0019 item 7, chat completions (2026-11-14): the Codex subscription backend answers 200 with no
// Content-Type at all. /v1/chat/completions reads such a body as an event stream only when the status is
// 200, the header is absent, and the request went to the Codex subscription backend; frame validation is
// unchanged. Diagnosis stays shape-only: fixed labels and counts in the server log, never body content.
// Real Express + v1 router over a test-owned file SQLite; the provider is a synthetic fetch.
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
const {logger} = await import('../src/utils/logger.ts');
const {default: router} = await import('../src/routes/v1.ts');
initDatabase();
const db = getDb();
const repo = new AccountRepository();
new UserRepository().create({apiKeyHash:hashApiKey('cu-key'), name:'cu', email:'cu@example.invalid', tier:'pro', dailyLimit:1000});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', router);
const server = http.createServer(app);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
assert.notEqual(server.address().port, 20128);
const nativeFetch = globalThis.fetch;
const originalError = logger.error;
const logged = [];
logger.error = (...args) => { logged.push(args); };
after(async () => { globalThis.fetch = nativeFetch; logger.error = originalError; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); });

const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MARKER = 'marker-5521-body-content';
const event = x => `data: ${JSON.stringify(x)}\n\n`;
const item = (status, content) => ({id:'msg_1', type:'message', status, role:'assistant', content});
const part = text => ({type:'output_text', text, annotations:[]});
const good = [{type:'response.created', response:{id:'resp_1', status:'in_progress'}}, {type:'response.in_progress', response:{id:'resp_1', status:'in_progress'}},
  {type:'response.output_item.added', output_index:0, item:item('in_progress', [])}, {type:'response.content_part.added', item_id:'msg_1', output_index:0, content_index:0, part:part('')},
  {type:'response.output_text.delta', item_id:'msg_1', output_index:0, content_index:0, delta:'hello'}, {type:'response.output_text.done', item_id:'msg_1', output_index:0, content_index:0, text:'hello'},
  {type:'response.content_part.done', item_id:'msg_1', output_index:0, content_index:0, part:part('hello')}, {type:'response.output_item.done', output_index:0, item:item('completed', [part('hello')])},
  {type:'response.completed', response:{id:'resp_1', status:'completed', output:[item('completed', [part('hello')])]}}];
const goodBody = good.map(event).join('');

const accounts = [];
function only(kind) {
  for (const a of accounts) repo.update(a.id, {status:'disabled'});
  const name = `cu-${kind}-${accounts.length}`;
  const a = kind === 'sub'
    ? repo.create({name, provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:`cat-${accounts.length}`, refreshToken:`crt-${accounts.length}`, accountId:'ws-cu', expiresAt:Date.now() + 3600_000})})
    : repo.create({name, provider:'openai', credentialType:'api_key', credentials:`sk-cu${accounts.length}${'k'.repeat(20)}`});
  accounts.push(a); return a;
}
const calls = [];
// A string body would make Response add text/plain; a stream body leaves the header truly absent.
const streamOf = text => new ReadableStream({start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); }});
function provider(body, init = {status:200}) {
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(streamOf(body), init); };
}
function send(body) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/chat/completions', method:'POST', agent:false,
      headers:{authorization:'Bearer cu-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(raw)}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(raw);
  });
}
const chat = (stream = false) => send({model:'gpt-5', stream, messages:[{role:'user', content:'hi'}]});
const lastFailure = () => logged.filter(args => args[1] === 'Inference request failed').at(-1)?.[0];
const rested = a => Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(a.id)?.duration_ms);

test('Codex subscription: a 200 event stream with no Content-Type is answered, streamed and not', async () => {
  only('sub');
  provider(goodBody);
  const r = await chat(false);
  assert.equal(r.status, 200, r.text);
  assert.equal(calls.at(-1), CODEX_URL);
  assert.equal(JSON.parse(r.text).choices[0].message.content, 'hello');
  provider(goodBody);
  const s = await chat(true);
  assert.equal(s.status, 200, s.text);
  assert.match(String(s.headers['content-type']), /text\/event-stream/);
  assert.match(s.text, /"content":"hello"/);
  assert.match(s.text, /data: \[DONE\]/);
});

test('Codex subscription: an untyped body that is not a valid stream fails, rests the account, and logs only its shape', async () => {
  for (const [label, body, lead] of [['markup', `<html><body>${MARKER}</body></html>\n\n`, 'markup'], ['json', `{"error":"${MARKER}"}\n\n`, 'json'],
    ['cut', good.slice(0, 5).map(event).join(''), 'field'], ['empty', '', 'empty'], ['blank', '\n\n  \n', 'blank']]) {
    const a = only('sub');
    provider(body);
    const r = await chat(false);
    assert.equal(r.status, 502, `${label}: ${r.text}`);
    assert.ok(!r.text.includes(MARKER), `${label}: the body never reaches the client`);
    const entry = lastFailure();
    assert.equal(entry.upstreamStream?.rule, 'untyped_stream_invalid', label);
    assert.equal(entry.upstreamStream.lead, lead, label);
    assert.equal(entry.upstreamStream.bytes, Buffer.byteLength(body), label);
    if (label === 'cut') assert.equal(entry.upstreamStream.frames, 5, label);
    assert.ok(!JSON.stringify(entry).includes(MARKER), `${label}: no body content in the log`);
    assert.equal(rested(a), 60_000, `${label}: ADR 0008 60s rest after a 2xx the router could not use`);
  }
});

test('outside the exception the response is still refused, and the log records its header shape', async () => {
  const cases = [
    ['206 without a type', 'sub', {status:206}, {status:206, contentType:null}],
    ['an empty type value', 'sub', {status:200, headers:{'content-type':''}}, {status:200, contentType:''}],
    ['a JSON type', 'sub', {status:200, headers:{'content-type':'application/json'}}, {status:200, contentType:'application/json'}],
    ['an OpenAI API key without a type', 'key', {status:200}, {status:200, contentType:null}],
  ];
  for (const [label, kind, init, shape] of cases) {
    only(kind);
    provider(goodBody, init);
    const r = await chat(false);
    assert.equal(r.status, 502, `${label}: ${r.text}`);
    const entry = lastFailure();
    assert.equal(entry.upstream?.status, shape.status, label);
    assert.equal(entry.upstream.contentType, shape.contentType, label);
    assert.equal(entry.upstream.hasBody, true, label);
    assert.equal(entry.upstreamStream, undefined, label);
    assert.ok(!/upstreamShape|contentType|hasBody/.test(r.text), `${label}: the shape stays in the server log`);
    if (shape.contentType) assert.ok(!r.text.includes(shape.contentType), `${label}: no header value in the client body`);
  }
});

test('a typed event stream from a Codex subscription keeps working and carries no diagnosis', async () => {
  only('sub');
  provider(goodBody, {status:200, headers:{'content-type':'text/event-stream'}});
  const before = logged.length;
  const r = await chat(false);
  assert.equal(r.status, 200, r.text);
  assert.equal(logged.length, before);
});

test('a streaming client of an untyped body that turns out invalid gets an error, not the body, and the shape is logged', async () => {
  const a = only('sub');
  provider(`<html>${MARKER}</html>\n\n`);
  const r = await chat(true);
  assert.ok(!r.text.includes(MARKER), r.text);
  assert.ok(!/"content":/.test(r.text), 'no content was produced');
  assert.equal(r.status, 200, 'chat completions sends its headers before the first upstream frame');
  assert.match(r.text, /data: \{"error":\{"type":"upstream_error","message":"Malformed or incomplete upstream stream"\}\}/);
  const entry = lastFailure();
  assert.equal(entry.upstreamStream?.rule, 'untyped_stream_invalid');
  assert.equal(entry.upstreamStream.lead, 'markup');
  assert.equal(rested(a), 60_000);
});

const withUsage = [...good.slice(0, -1), {...good.at(-1), response:{...good.at(-1).response, usage:{input_tokens:7, output_tokens:11}}}].map(event).join('');
const usageOf = a => db.prepare('SELECT input_tokens AS input, output_tokens AS output, success FROM usage_logs WHERE upstream_account_id=? ORDER BY id DESC LIMIT 1').get(a.id);

test('usage recorded from an untyped stream matches a typed one', async () => {
  const typed = only('sub');
  provider(withUsage, {status:200, headers:{'content-type':'text/event-stream'}});
  assert.equal((await chat(false)).status, 200);
  const untyped = only('sub');
  provider(withUsage);
  const r = await chat(false);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text).usage, {prompt_tokens:7, completion_tokens:11, total_tokens:18});
  assert.deepEqual(usageOf(untyped), usageOf(typed));
  assert.deepEqual(usageOf(untyped), {input:7, output:11, success:1});
});

test('a provider error event inside an untyped stream is labelled as a failure, not as a malformed body', async () => {
  only('sub');
  provider([good[0], {type:'response.failed', sequence_number:1, response:{id:'resp_1', status:'failed', error:{code:'server_error', message:MARKER}}}].map(event).join(''));
  const r = await chat(false);
  assert.equal(r.status, 502, r.text);
  assert.ok(!r.text.includes(MARKER));
  const entry = lastFailure();
  assert.equal(entry.upstreamStream?.rule, 'untyped_stream_failed');
  assert.equal(entry.upstreamStream.lead, 'field');
  assert.ok(!JSON.stringify(entry).includes(MARKER));
});

test('a client that disconnects mid-stream cancels the untyped provider body', async () => {
  only('sub');
  let cancelled = 0;
  globalThis.fetch = async url => {
    calls.push(String(url));
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(good.slice(0, 5).map(event).join(''))); },
      cancel() { cancelled++; },
    }), {status:200});
  };
  const before = logged.length;
  await new Promise((resolve, reject) => {
    const raw = JSON.stringify({model:'gpt-5', stream:true, messages:[{role:'user', content:'hi'}]});
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/chat/completions', method:'POST', agent:false,
      headers:{authorization:'Bearer cu-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(raw)}}, res => {
      res.on('data', chunk => { if (String(chunk).includes('hello')) { req.destroy(); resolve(); } });
    });
    req.on('error', () => {}); req.end(raw);
    setTimeout(() => reject(new Error('no delta arrived')), 3000);
  });
  for (let i = 0; i < 100 && !cancelled; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(cancelled, 1, 'the provider body is cancelled when the client leaves');
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!logged.slice(before).some(args => args[0]?.upstreamStream), 'a cancellation is not labelled as a stream failure');
});

test('the exception holds only for the Codex subscription backend URL (module level)', async () => {
  // Same bare-VM harness as inference-invalid-stream-disposal: the module must not need imports or extra globals.
  const {readFileSync} = await import('node:fs');
  const vm = await import('node:vm');
  const ts = (await import('typescript')).default;
  const code = ts.transpileModule(readFileSync(new URL('../src/upstream/inference.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, TextDecoder, fetch() { throw new Error('Unexpected network call'); }, require() { throw new Error('Unexpected import'); }});
  const auth = {kind:'oauth', token:'cat-vm', accountId:'ws-vm'}, request = {model:'gpt-5', messages:[{role:'user', content:'hi'}]};
  const untypedResponse = () => async () => new Response(streamOf(goodBody), {status:200});
  const events = await exports.infer('openai', auth, request, undefined, undefined, untypedResponse());
  const texts = []; for await (const e of events) if (e.text) texts.push(e.text);
  assert.deepEqual(texts, ['hello'], 'the default Codex URL accepts an untyped stream');
  await assert.rejects(exports.infer('openai', auth, request, 'https://elsewhere.invalid/codex/responses', undefined, untypedResponse()),
    e => e.status === 502 && e.message === 'Upstream did not return an event stream', 'any other endpoint is refused');
});

