// Phase 5 (ADR 0019): same-protocol passthrough for Claude Code (/v1/messages)
// and Codex (/v1/responses). Real Express + v1 router (auth, quota, tracking)
// over a test-owned file SQLite; synthetic fetch only, no real provider.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import Database from 'better-sqlite3';

Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(24), LOG_LEVEL:'error', LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const {initDatabase, closeDatabase, getDb} = await import('../src/db/client.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
const {captureRawBody, JSON_BODY_LIMIT} = await import('../src/http/raw-body.ts');
const {default: router} = await import('../src/routes/v1.ts');
initDatabase();
const db = getDb();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('p5-key'), name:'p5', email:'p5@example.invalid', tier:'pro', dailyLimit:1000});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', router);
const server = http.createServer(app);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
assert.notEqual(server.address().port, 20128);
const nativeFetch = globalThis.fetch;
after(async () => { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); });

const accounts = [];
function account(name, provider, credentialType, credentials) {
  for (const a of accounts) repo.update(a.id, {status:'disabled'});
  const a = repo.create({name, provider, credentialType, credentials});
  accounts.push(a); return a;
}
const anthropicKey = name => account(name, 'anthropic', 'api_key', `sk-ant-api03-${name}`);
const anthropicOauth = name => account(name, 'anthropic', 'oauth', JSON.stringify({kind:'oauth', accessToken:`oat-${name}`, refreshToken:`ort-${name}`, expiresAt:Date.now() + 3600_000}));
const openaiKey = name => account(name, 'openai', 'api_key', `sk-${name}`);
const codexOauth = name => account(name, 'openai', 'oauth', JSON.stringify({kind:'oauth', accessToken:`cat-${name}`, refreshToken:`crt-${name}`, accountId:`ws-${name}`, expiresAt:Date.now() + 3600_000}));
const open = id => db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(id);
const restriction = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);
const usage = id => db.prepare('SELECT input_tokens AS input, output_tokens AS output, success FROM usage_logs WHERE upstream_account_id=? ORDER BY rowid DESC').get(id);

let calls = [];
function upstream(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const call = {url:String(url), headers:Object.fromEntries(new Headers(init.headers).entries()), body:Buffer.from(init.body).toString('utf8'), redirect:init.redirect};
    calls.push(call);
    return handler(call, init);
  };
}
const sse = (frames, headers = {}) => new Response(frames.join(''), {status:200, headers:{'content-type':'text/event-stream', ...headers}});
function send(path, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method:'POST', agent:false,
      headers:{authorization:'Bearer p5-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(rawBody), ...headers}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(rawBody);
  });
}

// --- Anthropic Messages fixtures (Claude Code shaped) ---
// Odd whitespace and key order prove the raw request bytes are forwarded unchanged.
const claudeBody = `{"model":"claude-opus-5-5",  "max_tokens":32000,"stream":true,
 "system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=9.9"},{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude.","cache_control":{"type":"ephemeral"}}],
 "messages":[{"role":"user","content":[{"type":"text","text":"read a.txt"}]},
  {"role":"assistant","content":[{"type":"thinking","thinking":"plan","signature":"sig-ABC=="},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.txt"}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"hello","cache_control":{"type":"ephemeral"}}]}],
 "tools":[{"name":"Read","description":"read","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}}},"strict":true}],
 "thinking":{"type":"adaptive"},"context_management":{"edits":[]},"output_config":{"effort":"high"},"metadata":{"user_id":"u"}}`;
const claudeHeaders = {'anthropic-version':'2023-06-01', 'anthropic-beta':'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27', 'user-agent':'claude-cli/9.9.9 (external, cli)', 'x-app':'cli', 'x-claude-code-session-id':'sess-1', 'openai-organization':'must-not-forward'};
const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const claudeFrames = [
  ev('message_start', {type:'message_start', message:{id:'msg_1', type:'message', role:'assistant', model:'claude-opus-5-5', content:[], stop_reason:null, usage:{input_tokens:11, cache_creation_input_tokens:5, cache_read_input_tokens:7, output_tokens:1}}}),
  ev('ping', {type:'ping'}),
  ev('content_block_start', {type:'content_block_start', index:0, content_block:{type:'thinking', thinking:'', signature:''}}),
  ev('content_block_delta', {type:'content_block_delta', index:0, delta:{type:'thinking_delta', thinking:'need file'}}),
  ev('content_block_delta', {type:'content_block_delta', index:0, delta:{type:'signature_delta', signature:'sig-XYZ=='}}),
  ev('content_block_stop', {type:'content_block_stop', index:0}),
  ': keep-alive comment\n\n',
  ev('content_block_start', {type:'content_block_start', index:1, content_block:{type:'tool_use', id:'toolu_2', name:'Read', input:{}}}),
  ev('content_block_delta', {type:'content_block_delta', index:1, delta:{type:'input_json_delta', partial_json:'{"file_path":"b.txt"}'}}),
  ev('content_block_stop', {type:'content_block_stop', index:1}),
  ev('message_delta', {type:'message_delta', delta:{stop_reason:'tool_use', stop_sequence:null}, usage:{output_tokens:42}}),
  ev('message_stop', {type:'message_stop'}),
];

test('messages: API key stream forwards request bytes, headers and every SSE frame unchanged', async () => {
  const a = anthropicKey('m-key');
  upstream(() => sse(claudeFrames, {'anthropic-ratelimit-unified-status':'allowed', 'request-id':'req_1', 'set-cookie':'x=1', 'anthropic-organization-id':'org-pool-owner'}));
  const r = await send('/v1/messages?beta=true', claudeBody, claudeHeaders);
  assert.equal(r.status, 200, r.text);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(c.redirect, 'manual');
  assert.equal(c.body, claudeBody, 'raw request bytes are forwarded unchanged');
  assert.equal(c.headers['x-api-key'], 'sk-ant-api03-m-key');
  assert.equal(c.headers.authorization, undefined);
  assert.equal(c.headers['anthropic-beta'], claudeHeaders['anthropic-beta']);
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.headers['user-agent'], claudeHeaders['user-agent']);
  assert.equal(c.headers['x-app'], 'cli');
  assert.equal(c.headers['x-claude-code-session-id'], 'sess-1');
  assert.equal(c.headers['openai-organization'], undefined);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  assert.equal(r.text, claudeFrames.join(''), 'SSE frames relayed byte for byte');
  assert.equal(r.headers['anthropic-ratelimit-unified-status'], 'allowed');
  assert.equal(r.headers['request-id'], 'req_1');
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(r.headers['anthropic-organization-id'], undefined, 'pooled account identity is not relayed');
  assert.equal(open(a.id), undefined, 'OPEN settled');
  assert.equal(restriction(a.id), undefined);
  assert.deepEqual({...usage(a.id)}, {input:23, output:42, success:1});
});

test('messages: subscription OAuth adds only the bearer token and the OAuth beta', async () => {
  const a = anthropicOauth('m-oauth');
  upstream(() => sse(claudeFrames));
  const r = await send('/v1/messages?beta=true', claudeBody, claudeHeaders);
  assert.equal(r.status, 200, r.text);
  const c = calls[0];
  assert.equal(c.headers.authorization, 'Bearer oat-m-oauth');
  assert.equal(c.headers['x-api-key'], undefined);
  assert.equal(c.headers['anthropic-beta'], `${claudeHeaders['anthropic-beta']},oauth-2025-04-20`);
  assert.equal(c.body, claudeBody, 'system array and body untouched for OAuth');
  assert.equal(r.text, claudeFrames.join(''));
  assert.equal(open(a.id), undefined);
});

test('messages: OAuth beta is not duplicated when the client already sent it', async () => {
  anthropicOauth('m-oauth-dup');
  upstream(() => sse(claudeFrames));
  const r = await send('/v1/messages', claudeBody, {...claudeHeaders, 'anthropic-beta':'oauth-2025-04-20,claude-code-20250219'});
  assert.equal(r.status, 200, r.text);
  assert.equal(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
});

test('messages: non-stream JSON response is forwarded unchanged and settles', async () => {
  const a = anthropicKey('m-json');
  const body = '{"model":"claude-haiku-5-5","max_tokens":10,"messages":[{"role":"user","content":"title"}]}';
  const reply = '{"id":"msg_2","type":"message","role":"assistant","content":[{"type":"text","text":"Title"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}';
  upstream(() => new Response(reply, {status:200, headers:{'content-type':'application/json'}}));
  const r = await send('/v1/messages', body, claudeHeaders);
  assert.equal(r.status, 200);
  assert.equal(r.text, reply);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(open(a.id), undefined);
  assert.deepEqual({...usage(a.id)}, {input:3, output:2, success:1});
});

test('messages: provider 4xx error status, headers and body are forwarded unchanged (decision 3B)', async () => {
  const a = anthropicKey('m-400');
  const err = '{"type":"error","error":{"type":"invalid_request_error","message":"context_management: Extra inputs are not permitted"}}';
  upstream(() => new Response(err, {status:400, headers:{'content-type':'application/json', 'request-id':'req_400'}}));
  const r = await send('/v1/messages', claudeBody, claudeHeaders);
  assert.equal(r.status, 400);
  assert.equal(r.text, err);
  assert.equal(r.headers['request-id'], 'req_400');
  assert.equal(open(a.id), undefined);
  assert.equal(restriction(a.id), undefined, 'a request error does not restrict the account');
});

test('messages: provider 429 is forwarded with its headers and arms the shared restriction', async () => {
  const a = anthropicKey('m-429');
  const err = '{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}';
  upstream(() => new Response(err, {status:429, headers:{'content-type':'application/json', 'retry-after':'30', 'anthropic-ratelimit-unified-status':'rejected'}}));
  const r = await send('/v1/messages', claudeBody, claudeHeaders);
  assert.equal(r.status, 429);
  assert.equal(r.text, err);
  assert.equal(r.headers['retry-after'], '30');
  assert.equal(r.headers['anthropic-ratelimit-unified-status'], 'rejected');
  assert.equal(open(a.id), undefined);
  assert.equal(restriction(a.id)?.duration_ms, 30_000, 'Retry-After delta seconds drive the shared restriction');
});

test('messages: an in-stream overloaded error is relayed and settles the attempt with a 5xx restriction', async () => {
  const a = anthropicKey('m-overload');
  const frames = [claudeFrames[0], ev('error', {type:'error', error:{type:'overloaded_error', message:'Overloaded'}})];
  upstream(() => sse(frames));
  const r = await send('/v1/messages', claudeBody, claudeHeaders);
  assert.equal(r.status, 200);
  assert.equal(r.text, frames.join(''), 'provider error event relayed, no router-made terminal added');
  assert.equal(open(a.id), undefined, 'provider terminal settles the OPEN');
  assert.ok(restriction(a.id), '5xx-class provider error arms the shared restriction');
});

test('messages: a truncated stream ends with a router error event and keeps the uncertain OPEN', async () => {
  const a = anthropicKey('m-trunc');
  const frames = claudeFrames.slice(0, 4);
  upstream(() => sse(frames));
  const r = await send('/v1/messages', claudeBody, claudeHeaders);
  assert.equal(r.status, 200);
  assert.ok(r.text.startsWith(frames.join('')));
  const tail = r.text.slice(frames.join('').length);
  assert.match(tail, /^event: error\ndata: /);
  assert.equal(JSON.parse(tail.split('\n')[1].slice(6)).type, 'error');
  assert.doesNotMatch(r.text, /message_stop/);
  assert.ok(open(a.id), 'uncertain outcome keeps the OPEN (ADR 0008)');
});

test('messages: router errors use the Anthropic error envelope; OpenAI accounts are never used', async () => {
  openaiKey('m-only-openai');
  upstream(() => { throw new Error('must not dispatch'); });
  const r = await send('/v1/messages', claudeBody, claudeHeaders);
  assert.equal(r.status, 503);
  const body = JSON.parse(r.text);
  assert.equal(body.type, 'error');
  assert.equal(typeof body.error.type, 'string');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(calls.length, 0);
});

test('messages: invalid JSON shape is rejected locally in the Anthropic envelope', async () => {
  anthropicKey('m-invalid');
  upstream(() => { throw new Error('must not dispatch'); });
  const r = await send('/v1/messages', '{"model":5,"messages":[]}', claudeHeaders);
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error.type, 'invalid_request_error');
  assert.equal(calls.length, 0);
});

// --- OpenAI Responses fixtures (Codex shaped) ---
const codexBody = `{"model":"gpt-6.1-sol","instructions":"You are Codex.","input":[
 {"type":"message","role":"user","content":[{"type":"input_text","text":"list files"}]},
 {"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"gAAAA-enc"},
 {"type":"function_call","call_id":"call_1","name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"},
 {"type":"function_call_output","call_id":"call_1","output":"a.txt"}],
 "tools":[{"type":"function","name":"shell","parameters":{"type":"object"},"strict":false}],
 "tool_choice":"auto","parallel_tool_calls":false,"reasoning":{"effort":"high","summary":"auto"},
 "store":false,"stream":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"conv-1"}`;
const codexHeaders = {'user-agent':'codex_cli_rs/9.9.9', originator:'codex_cli_rs', version:'9.9.9', session_id:'conv-1', 'openai-beta':'responses=experimental', 'chatgpt-account-id':'client-supplied', 'openai-organization':'must-not-forward'};
const rev = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const codexFrames = [
  rev({type:'response.created', sequence_number:0, response:{id:'resp_1', status:'in_progress', output:[]}}),
  rev({type:'response.in_progress', sequence_number:1, response:{id:'resp_1', status:'in_progress'}}),
  rev({type:'response.output_item.added', sequence_number:2, output_index:0, item:{type:'reasoning', id:'rs_2', summary:[]}}),
  rev({type:'response.output_item.done', sequence_number:3, output_index:0, item:{type:'reasoning', id:'rs_2', summary:[], encrypted_content:'gAAAA-new'}}),
  rev({type:'response.output_item.added', sequence_number:4, output_index:1, item:{type:'function_call', id:'fc_1', call_id:'call_2', name:'shell', arguments:''}}),
  rev({type:'response.function_call_arguments.delta', sequence_number:5, item_id:'fc_1', output_index:1, delta:'{"command":["cat","a.txt"]}'}),
  rev({type:'response.output_item.done', sequence_number:6, output_index:1, item:{type:'function_call', id:'fc_1', call_id:'call_2', name:'shell', arguments:'{"command":["cat","a.txt"]}'}}),
  rev({type:'response.completed', sequence_number:7, response:{id:'resp_1', status:'completed', output:[], usage:{input_tokens:100, input_tokens_details:{cached_tokens:60}, output_tokens:20, total_tokens:120}}}),
];

test('responses: API key stream forwards request bytes and every SSE frame unchanged', async () => {
  const a = openaiKey('r-key');
  upstream(() => sse(codexFrames, {'x-ratelimit-remaining-requests':'99', 'x-request-id':'rq_1', 'openai-organization':'org-pool-owner', 'openai-project':'proj-pool'}));
  const r = await send('/v1/responses', codexBody, codexHeaders);
  assert.equal(r.status, 200, r.text);
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/responses');
  assert.equal(c.body, codexBody);
  assert.equal(c.headers.authorization, 'Bearer sk-r-key');
  assert.equal(c.headers['chatgpt-account-id'], undefined, 'client-supplied workspace id is not forwarded');
  assert.equal(c.headers['openai-organization'], undefined);
  assert.equal(c.headers.originator, 'codex_cli_rs');
  assert.equal(c.headers.session_id, 'conv-1');
  assert.equal(r.text, codexFrames.join(''));
  assert.equal(r.headers['x-ratelimit-remaining-requests'], '99');
  assert.equal(r.headers['openai-organization'], undefined);
  assert.equal(r.headers['openai-project'], undefined);
  assert.equal(open(a.id), undefined);
  assert.deepEqual({...usage(a.id)}, {input:100, output:20, success:1});
});

test('responses: Codex subscription OAuth uses the ChatGPT Codex backend with the stored workspace id', async () => {
  const a = codexOauth('r-oauth');
  upstream(() => sse(codexFrames));
  const r = await send('/v1/responses', codexBody, codexHeaders);
  assert.equal(r.status, 200, r.text);
  const c = calls[0];
  assert.equal(c.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(c.headers.authorization, 'Bearer cat-r-oauth');
  assert.equal(c.headers['chatgpt-account-id'], 'ws-r-oauth');
  assert.equal(c.headers.originator, 'codex_cli_rs');
  assert.equal(c.body, codexBody);
  assert.equal(r.text, codexFrames.join(''));
  assert.equal(open(a.id), undefined);
});

test('responses: response.failed is relayed as a provider terminal', async () => {
  const a = openaiKey('r-failed');
  const frames = [codexFrames[0], rev({type:'response.failed', sequence_number:1, response:{id:'resp_1', status:'failed', error:{code:'server_error', message:'boom'}}})];
  upstream(() => sse(frames));
  const r = await send('/v1/responses', codexBody, codexHeaders);
  assert.equal(r.status, 200);
  assert.equal(r.text, frames.join(''));
  assert.equal(open(a.id), undefined);
  assert.ok(restriction(a.id));
});

test('responses: provider 401 body is forwarded unchanged for an API key account (decision 3B)', async () => {
  openaiKey('r-401');
  const err = '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}';
  upstream(() => new Response(err, {status:401, headers:{'content-type':'application/json'}}));
  const r = await send('/v1/responses', codexBody, codexHeaders);
  assert.equal(r.status, 401);
  assert.equal(r.text, err);
  assert.equal(calls.length, 1);
});

test('responses: router errors use the Responses error envelope; Anthropic accounts are never used', async () => {
  anthropicKey('r-only-anthropic');
  upstream(() => { throw new Error('must not dispatch'); });
  const r = await send('/v1/responses', codexBody, codexHeaders);
  assert.equal(r.status, 503);
  const body = JSON.parse(r.text);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.type, undefined);
  assert.equal(calls.length, 0);
});

// --- Review B1: a provider terminal (success or failure) reaches the client only after settlement ---
const enc = new TextEncoder();
function heldUpstream() {
  let c; const body = new ReadableStream({start(controller) { c = controller; }});
  return {body, push: f => c.enqueue(enc.encode(f)), end: () => c.close()};
}
function streamingSend(path, rawBody, headers) {
  const chunks = [];
  let resolveFirst; const first = new Promise(r => { resolveFirst = r; });
  const done = new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method:'POST', agent:false,
      headers:{authorization:'Bearer p5-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(rawBody), ...headers}}, res => {
      res.setEncoding('utf8'); res.on('data', d => { chunks.push(d); resolveFirst(); }); res.on('end', () => resolve(chunks.join('')));
    });
    req.on('error', reject); req.end(rawBody);
  });
  return {first, done, text: () => chunks.join('')};
}
const codexHeadersPlain = codexHeaders;
for (const [label, path, body, headers, head, tail, settled] of [
  ['messages: an in-stream provider error', '/v1/messages', claudeBody, claudeHeaders, claudeFrames[0], [ev('error', {type:'error', error:{type:'overloaded_error', message:'Overloaded'}})], 'restricted'],
  ['messages: message_stop', '/v1/messages', claudeBody, claudeHeaders, claudeFrames[0], claudeFrames.slice(1), 'clean'],
  ['responses: response.failed', '/v1/responses', codexBody, codexHeadersPlain, codexFrames[0], [rev({type:'response.failed', sequence_number:1, response:{id:'resp_1', status:'failed', error:{code:'server_error', message:'boom'}}})], 'restricted'],
  ['responses: response.completed', '/v1/responses', codexBody, codexHeadersPlain, codexFrames[0], codexFrames.slice(1), 'clean'],
]) {
  test(`${label} is withheld from the client until the attempt is settled`, async () => {
    const a = path === '/v1/messages' ? anthropicKey(`order-${label}`) : openaiKey(`order-${label}`);
    const held = heldUpstream();
    upstream(() => new Response(held.body, {headers:{'content-type':'text/event-stream'}}));
    const r = streamingSend(path, body, headers);
    held.push(head);
    await r.first;
    const lock = new Database(db.name); lock.exec('BEGIN IMMEDIATE');
    try {
      for (const f of tail) held.push(f); held.end();
      await new Promise(res => setTimeout(res, 300));
      assert.ok(open(a.id), 'settlement is blocked by the held writer lock');
      const last = tail[tail.length - 1];
      assert.equal(r.text().includes(last), false, 'terminal frame not yet visible while unsettled');
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    const text = await r.done;
    assert.ok(text.endsWith(tail[tail.length - 1]));
    assert.ok(text.endsWith('\n\n'), 'the terminal frame keeps its SSE delimiter');
    assert.equal(open(a.id), undefined);
    if (settled === 'restricted') assert.ok(restriction(a.id)); else assert.equal(restriction(a.id), undefined);
  });
}

// --- Review B2: routing decisions and forwarded bytes must agree ---
test('messages: a repeated top-level key (e.g. two models) is rejected before dispatch', async () => {
  anthropicKey('dup-key');
  upstream(() => { throw new Error('must not dispatch'); });
  const r = await send('/v1/messages', '{"model":"claude-haiku-5-5","max_tokens":5,"messages":[{"role":"user","content":"x"}],"model":"claude-opus-5-5"}', claudeHeaders);
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).type, 'error');
  assert.equal(calls.length, 0);
  // Nested repeats are not routing-relevant and are forwarded unchanged.
  upstream(() => sse(claudeFrames));
  const nested = '{"model":"claude-haiku-5-5","max_tokens":5,"messages":[{"role":"user","content":"x"}],"metadata":{"a":1,"a":2}}';
  const ok = await send('/v1/messages', nested, claudeHeaders);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(calls[0].body, nested);
});

function rawSend(path, bytes, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method:'POST', agent:false,
      headers:{authorization:'Bearer p5-key', 'content-type':contentType, 'content-length':bytes.length}}, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({status:res.statusCode, text:d}));
    });
    req.on('error', reject); req.end(bytes);
  });
}
test('messages: non-UTF-8 charsets (UTF-16, UTF-7) are rejected before routing, without hanging', {timeout:5000}, async () => {
  anthropicKey('charset');
  upstream(() => { throw new Error('must not dispatch'); });
  const json = '{"model":"claude-haiku-5-5","max_tokens":5,"messages":[{"role":"user","content":"x"}]}';
  for (const [bytes, type] of [
    [Buffer.from('\ufeff' + json, 'utf16le'), 'application/json; charset=utf-16'],
    [Buffer.from(json, 'utf16le'), 'application/json; charset=utf-16le'],
    // UTF-7 decodes to valid JSON for body-parser but contains no '"' bytes at all.
    [Buffer.from('{+ACI-model+ACI-:+ACI-claude-haiku-5-5+ACI-,+ACI-max+AF8-tokens+ACI-:5,+ACI-messages+ACI-:[{+ACI-role+ACI-:+ACI-user+ACI-,+ACI-content+ACI-:+ACI-x+ACI-}]}', 'ascii'), 'application/json; charset=UTF-7'],
  ]) {
    const r = await rawSend('/v1/messages', bytes, type);
    assert.ok(r.status === 400 || r.status === 415, `${type}: ${r.status} ${r.text}`);
  }
  assert.equal(calls.length, 0);
});

test('responses: background responses are rejected locally', async () => {
  openaiKey('r-background');
  upstream(() => { throw new Error('must not dispatch'); });
  const r = await send('/v1/responses', '{"model":"gpt-6.1-sol","input":"x","background":true}', codexHeaders);
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

// --- Review follow-ups (deleg_5fe04403, non-blocking) ---
test('duplicate-key scanner: defensive branches end immediately with a 400 on malformed text', async () => {
  const {assertNoDuplicateTopLevelKeys} = await import('../src/upstream/passthrough.ts');
  const status = text => { try { assertNoDuplicateTopLevelKeys(text); return 'ok'; } catch (e) { return e.status; } };
  for (const text of ['', '"x"', '{"a', '{"a\\', '{"a" 1}', '{"a":1', '{"a":"1', '[1]']) assert.equal(status(text), 400, JSON.stringify(text));
  // Precondition: callers pass text that JSON.parse already accepted; other invalid JSON only has to terminate.
  assert.ok(['ok', 400].includes(status('{"a":1 "b":2}')));
  assert.equal(status('{ }'), 'ok');
  assert.equal(status('{"a":{"a":1,"a":2},"b":[{"a":1}]}'), 'ok', 'nested repeats are allowed');
  assert.equal(status('{"model":"a","mod\\u0065l":"b"}'), 400, 'escaped duplicate keys are normalized');
  assert.equal(status('{"a":"x\\"y","b":"}{,","a":0}'), 400, 'quotes, braces and commas inside strings do not confuse the scan');
});

test('messages: an escaped duplicate key and a UTF-8 BOM are rejected before dispatch', async () => {
  anthropicKey('bom');
  upstream(() => { throw new Error('must not dispatch'); });
  const esc = await send('/v1/messages', '{"model":"claude-haiku-5-5","max_tokens":5,"messages":[{"role":"user","content":"x"}],"mod\\u0065l":"claude-opus-5-5"}', claudeHeaders);
  assert.equal(esc.status, 400);
  const bom = await rawSend('/v1/messages', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"model":"claude-haiku-5-5","max_tokens":5,"messages":[{"role":"user","content":"x"}]}')]), 'application/json');
  assert.ok(bom.status === 400, `${bom.status} ${bom.text}`);
  assert.equal(calls.length, 0);
});
