// ADR 0022: Claude Code (/v1/messages) with an OpenAI model name is translated to the Responses API
// and served by OpenAI accounts (API key, Codex OAuth). Real Express + v1 router (auth, quota,
// tracking) over a test-owned file SQLite; synthetic fetch only, no real provider.
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
const {default: router} = await import('../src/routes/v1.ts');
initDatabase();
const db = getDb();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('x1-key'), name:'x1', email:'x1@example.invalid', tier:'pro', dailyLimit:1000});
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
const openaiKey = name => account(name, 'openai', 'api_key', `sk-${name}`);
const codexOauth = name => account(name, 'openai', 'oauth', JSON.stringify({kind:'oauth', accessToken:`cat-${name}`, refreshToken:`crt-${name}`, accountId:`ws-${name}`, expiresAt:Date.now() + 3600_000}));
const anthropicOauth = name => account(name, 'anthropic', 'oauth', JSON.stringify({kind:'oauth', accessToken:`oat-${name}`, refreshToken:`ort-${name}`, expiresAt:Date.now() + 3600_000}));
const open = id => db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(id);
const restriction = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);
const usage = id => db.prepare('SELECT input_tokens AS input, output_tokens AS output, success, model, provider FROM usage_logs WHERE upstream_account_id=? ORDER BY rowid DESC').get(id);

let calls = [];
function upstream(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const call = {url:String(url), headers:Object.fromEntries(new Headers(init.headers).entries()), body:JSON.parse(Buffer.from(init.body).toString('utf8'))};
    calls.push(call);
    return handler(call, init);
  };
}
const sse = (events, headers = {}) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {status:200, headers:{'content-type':'text/event-stream', ...headers}});
function send(body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/messages', method:'POST', agent:false,
      headers:{authorization:'Bearer x1-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(raw), 'anthropic-version':'2023-06-01', 'anthropic-beta':'claude-code-20250219', 'user-agent':'claude-cli/9.9.9', ...headers}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(raw);
  });
}
const events = text => text.split('\n\n').filter(Boolean).map(f => { const [e, d] = f.split('\n'); return {event:e.slice(7), data:JSON.parse(d.slice(6))}; });

const longName = 'mcp__very-long-server-name-for-testing__a_tool_name_that_is_far_too_long_for_openai';
const claudeBody = {
  model:'gpt-5.1-codex(high)', max_tokens:32000, stream:true,
  system:[{type:'text', text:'You are Claude Code.'}, {type:'text', text:'Be brief.', cache_control:{type:'ephemeral'}}],
  messages:[
    {role:'user', content:[{type:'text', text:'read a.txt'}, {type:'image', source:{type:'base64', media_type:'image/png', data:'iVBORw0K'}}]},
    {role:'assistant', content:[{type:'thinking', thinking:'plan', signature:'sig-ABC=='}, {type:'text', text:'Reading.'}, {type:'tool_use', id:'toolu_1', name:'Read', input:{file_path:'a.txt'}}]},
    {role:'user', content:[{type:'tool_result', tool_use_id:'toolu_1', content:[{type:'text', text:'hello'}], cache_control:{type:'ephemeral'}}, {type:'text', text:'now edit it'}]},
  ],
  tools:[
    {name:'Read', description:'read', input_schema:{type:'object', properties:{file_path:{type:'string'}}}, strict:true},
    {name:longName, input_schema:{type:'object', properties:{}}},
    {type:'web_search_20250305', name:'web_search', max_uses:5},
  ],
  tool_choice:{type:'auto', disable_parallel_tool_use:true},
  thinking:{type:'adaptive'}, output_config:{effort:'low'}, context_management:{edits:[]}, metadata:{user_id:'u'}, temperature:1,
};
const R = (type, extra = {}) => ({type, ...extra});
const respFrames = (output, {status = 'completed', usage = {input_tokens:120, input_tokens_details:{cached_tokens:20}, output_tokens:42}, incomplete} = {}) => [
  R('response.created', {response:{id:'resp_1', status:'in_progress'}}),
  R('response.in_progress', {response:{id:'resp_1', status:'in_progress'}}),
  ...output,
  R(status === 'incomplete' ? 'response.incomplete' : 'response.completed', {response:{id:'resp_1', status, usage, ...(incomplete ? {incomplete_details:{reason:incomplete}} : {})}}),
];
const reasoningItem = [R('response.output_item.added', {output_index:0, item:{id:'rs_1', type:'reasoning', summary:[]}}), R('response.reasoning_summary_text.delta', {item_id:'rs_1', delta:'secret plan'}), R('response.output_item.done', {output_index:0, item:{id:'rs_1', type:'reasoning'}})];
const textItem = (id, ...parts) => [R('response.output_item.added', {item:{id, type:'message', role:'assistant', content:[]}}), ...parts.map(p => R('response.output_text.delta', {item_id:id, delta:p})), R('response.output_item.done', {item:{id, type:'message'}})];
const callItem = (id, callId, name, args) => [R('response.output_item.added', {item:{id, type:'function_call', call_id:callId, name, arguments:''}}), ...args.map(a => R('response.function_call_arguments.delta', {item_id:id, delta:a})), R('response.output_item.done', {item:{id, type:'function_call', call_id:callId, name, arguments:args.join('')}})];

test('a Claude model on /v1/messages still goes to Anthropic unchanged', async () => {
  anthropicOauth('x-claude');
  upstream(() => new Response(JSON.stringify({error:{type:'invalid_request_error', message:'stop here'}}), {status:400, headers:{'content-type':'application/json'}}));
  const r = await send({...claudeBody, model:'claude-opus-5-5'});
  assert.equal(r.status, 400);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
});

test('API key: the request is translated to the Responses API', async () => {
  const a = openaiKey('x-key');
  upstream(() => sse(respFrames(textItem('m1', 'ok'))));
  const r = await send(claudeBody);
  assert.equal(r.status, 200, r.text);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/responses');
  assert.equal(c.headers.authorization, 'Bearer sk-x-key');
  assert.equal(c.headers.accept, 'text/event-stream');
  for (const h of ['anthropic-version', 'anthropic-beta', 'user-agent', 'x-api-key', 'chatgpt-account-id']) assert.equal(c.headers[h], undefined, `${h} is not sent`);
  const wire = c.body.tools[1].name;
  assert.match(wire, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(wire, longName);
  assert.deepEqual(c.body, {
    model:'gpt-5.1-codex', instructions:'You are Claude Code.\n\nBe brief.',
    input:[
      {type:'message', role:'user', content:[{type:'input_text', text:'read a.txt'}, {type:'input_image', image_url:'data:image/png;base64,iVBORw0K'}]},
      {type:'message', role:'assistant', content:[{type:'output_text', text:'Reading.'}]},
      {type:'function_call', call_id:'toolu_1', name:'Read', arguments:'{"file_path":"a.txt"}'},
      {type:'function_call_output', call_id:'toolu_1', output:'hello'},
      {type:'message', role:'user', content:[{type:'input_text', text:'now edit it'}]},
    ],
    tools:[
      {type:'function', name:'Read', description:'read', parameters:{type:'object', properties:{file_path:{type:'string'}}}, strict:false},
      {type:'function', name:wire, parameters:{type:'object', properties:{}}, strict:false},
    ],
    tool_choice:'auto', parallel_tool_calls:false, reasoning:{effort:'high'}, max_output_tokens:32000, stream:true, store:false,
  });
  assert.equal(open(a.id), undefined, 'OPEN settled');
  assert.deepEqual({...usage(a.id)}, {input:120, output:42, success:1, model:'gpt-5.1-codex', provider:'openai'});
});

test('stream: text and a tool call come back as Anthropic events; reasoning is dropped', async () => {
  openaiKey('x-stream');
  upstream(call => sse(respFrames([...reasoningItem, ...textItem('m1', 'Hel', 'lo'), ...callItem('fc_1', 'call_9', call.body.tools[1].name, ['{"a"', ':1}'])])));
  const r = await send(claudeBody);
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  assert.doesNotMatch(r.text, /secret plan/, 'reasoning summaries are not shown');
  const ev = events(r.text);
  assert.deepEqual(ev.map(e => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  for (const e of ev) assert.equal(e.event, e.data.type);
  assert.equal(ev[0].data.message.model, 'gpt-5.1-codex(high)', 'the model name the client sent');
  assert.equal(ev[0].data.message.role, 'assistant');
  assert.deepEqual(ev[1].data, {type:'content_block_start', index:0, content_block:{type:'text', text:''}});
  assert.deepEqual(ev.slice(2, 4).map(e => e.data.delta), [{type:'text_delta', text:'Hel'}, {type:'text_delta', text:'lo'}]);
  assert.deepEqual(ev[5].data, {type:'content_block_start', index:1, content_block:{type:'tool_use', id:'call_9', name:longName, input:{}}});
  assert.deepEqual(ev.slice(6, 8).map(e => e.data.delta), [{type:'input_json_delta', partial_json:'{"a"'}, {type:'input_json_delta', partial_json:':1}'}]);
  assert.deepEqual(ev[9].data, {type:'message_delta', delta:{stop_reason:'tool_use', stop_sequence:null}, usage:{input_tokens:100, output_tokens:42, cache_read_input_tokens:20, cache_creation_input_tokens:0}});
});

test('stream: false gets one Anthropic message; max_output_tokens maps to max_tokens', async () => {
  openaiKey('x-json');
  upstream(() => sse(respFrames([...textItem('m1', 'part'), ...callItem('fc_1', 'call_1', 'Read', ['{"file_path":"b.txt"}'])], {status:'incomplete', incomplete:'max_output_tokens'})));
  const r = await send({...claudeBody, stream:false});
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers['content-type'], /^application\/json/);
  const m = JSON.parse(r.text);
  assert.equal(m.type, 'message'); assert.equal(m.role, 'assistant'); assert.equal(m.model, 'gpt-5.1-codex(high)');
  assert.deepEqual(m.content, [{type:'text', text:'part'}, {type:'tool_use', id:'call_1', name:'Read', input:{file_path:'b.txt'}}]);
  assert.equal(m.stop_reason, 'max_tokens');
  assert.equal(calls[0].body.stream, true, 'the provider is always asked for a stream');
});

test('Codex OAuth: Codex backend URL and headers, no output cap, default instructions', async () => {
  const a = codexOauth('x-codex');
  // The real Codex backend sends no Content-Type (ADR 0019 7); a string body would get text/plain added.
  const bytes = new TextEncoder().encode(respFrames(textItem('m1', 'ok')).map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  upstream(() => new Response(new ReadableStream({start(c) { c.enqueue(bytes); c.close(); }}), {status:200}));
  const r = await send({model:'gpt-5.1-codex', max_tokens:100, stream:true, messages:[{role:'user', content:'hi'}]});
  assert.equal(r.status, 200, r.text);
  const c = calls[0];
  assert.equal(c.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(c.headers.authorization, 'Bearer cat-x-codex');
  assert.equal(c.headers['chatgpt-account-id'], 'ws-x-codex');
  assert.equal(c.headers.originator, 'codex_cli_rs');
  assert.equal(c.body.max_output_tokens, undefined);
  assert.equal(c.body.instructions, 'You are a helpful assistant.');
  assert.equal(c.body.reasoning, undefined, 'no effort requested: provider default');
  assert.deepEqual(c.body.input, [{type:'message', role:'user', content:[{type:'input_text', text:'hi'}]}]);
  assert.deepEqual(events(r.text).map(e => e.event).slice(-2), ['message_delta', 'message_stop']);
  assert.equal(open(a.id), undefined);
});

test('reasoning level: suffix beats output_config.effort, which beats the thinking budget', async () => {
  openaiKey('x-effort');
  upstream(() => sse(respFrames(textItem('m1', 'ok'))));
  const base = {model:'gpt-5', max_tokens:10, messages:[{role:'user', content:'hi'}]};
  const effortOf = async body => { await send(body); return calls.at(-1).body.reasoning?.effort; };
  calls = [];
  assert.equal(await effortOf({...base, thinking:{type:'enabled', budget_tokens:5000}}), 'medium');
  assert.equal(await effortOf({...base, thinking:{type:'enabled', budget_tokens:1024}}), 'low');
  assert.equal(await effortOf({...base, thinking:{type:'enabled', budget_tokens:200000}}), 'xhigh');
  assert.equal(await effortOf({...base, thinking:{type:'enabled', budget_tokens:5000}, output_config:{effort:'high'}}), 'high');
  assert.equal(await effortOf({...base, model:'gpt-5(minimal)', output_config:{effort:'high'}}), 'minimal');
  assert.equal(await effortOf({...base, thinking:{type:'disabled'}}), undefined);
  assert.equal(calls.at(-1).body.model, 'gpt-5');
});

test('content that would be lost is refused with 400 before any provider call', async () => {
  const a = openaiKey('x-reject');
  upstream(() => { throw new Error('must not dispatch'); });
  const doc = {type:'document', source:{type:'base64', media_type:'application/pdf', data:'JVBERi0='}};
  for (const body of [
    {model:'gpt-5', max_tokens:10, messages:[{role:'user', content:[doc]}]},
    {model:'gpt-5', max_tokens:10, messages:[{role:'user', content:[{type:'tool_result', tool_use_id:'t', content:[doc]}]}]},
    {model:'gpt-5', max_tokens:10, messages:[{role:'assistant', content:[{type:'server_tool_use', id:'srv', name:'web_search', input:{}}]}]},
    {model:'gpt-5', max_tokens:10, stop_sequences:['END'], messages:[{role:'user', content:'hi'}]},
  ]) {
    const r = await send(body);
    assert.equal(r.status, 400, r.text);
    const err = JSON.parse(r.text);
    assert.equal(err.type, 'error'); assert.equal(err.error.type, 'invalid_request_error');
  }
  assert.equal(calls.length, 0);
  assert.equal(open(a.id), undefined);
});

test('provider HTTP 429 becomes an Anthropic rate_limit_error with the provider message and rests the account', async () => {
  const a = openaiKey('x-429');
  upstream(() => new Response(JSON.stringify({error:{message:'Rate limit reached for gpt-5', type:'requests', code:'rate_limit_exceeded'}}), {status:429, headers:{'content-type':'application/json', 'retry-after':'7', 'x-ratelimit-remaining-requests':'0', 'openai-organization':'org-pool'}}));
  const r = await send(claudeBody);
  assert.equal(r.status, 429);
  assert.deepEqual(JSON.parse(r.text), {type:'error', error:{type:'rate_limit_error', message:'Rate limit reached for gpt-5'}});
  assert.equal(r.headers['retry-after'], '7');
  assert.equal(r.headers['x-ratelimit-remaining-requests'], undefined, 'pooled-account usage headers are not relayed on the cross path');
  assert.equal(r.headers['openai-organization'], undefined);
  assert.ok(restriction(a.id), 'the account rests');
  assert.equal(open(a.id), undefined);
});

test('an in-stream provider failure becomes an Anthropic error event and rests the account', async () => {
  const a = openaiKey('x-fail');
  upstream(() => sse([R('response.created', {response:{id:'r', status:'in_progress'}}), ...textItem('m1', 'par'), R('response.failed', {response:{id:'r', status:'failed', error:{code:'rate_limit_exceeded', message:'Slow down'}}})]));
  const r = await send(claudeBody);
  assert.equal(r.status, 200);
  const ev = events(r.text);
  assert.deepEqual(ev.at(-1), {event:'error', data:{type:'error', error:{type:'rate_limit_error', message:'Slow down'}}});
  assert.ok(!ev.some(e => e.event === 'message_stop'), 'no fake success terminal');
  assert.ok(restriction(a.id));
  assert.equal(open(a.id), undefined);
});

test('an output item Claude Code cannot represent ends the stream with an error event', async () => {
  const a = openaiKey('x-unknown');
  upstream(() => sse(respFrames([R('response.output_item.added', {item:{id:'ws_1', type:'web_search_call', status:'in_progress'}})])));
  const r = await send(claudeBody);
  assert.equal(r.status, 200);
  const last = events(r.text).at(-1);
  assert.equal(last.event, 'error');
  assert.match(last.data.error.message, /cannot represent/);
  assert.equal(open(a.id), undefined);
});

test('refusal text is shown as text and is_error tool results are marked', async () => {
  openaiKey('x-refusal');
  upstream(() => sse(respFrames([R('response.output_item.added', {item:{id:'m1', type:'message', content:[]}}), R('response.refusal.delta', {item_id:'m1', delta:'I cannot help.'}), R('response.output_item.done', {item:{id:'m1', type:'message'}})])));
  const r = await send({model:'gpt-5', max_tokens:10, stream:false, messages:[{role:'user', content:[{type:'tool_result', tool_use_id:'t1', content:'boom', is_error:true}]}]});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text).content, [{type:'text', text:'I cannot help.'}]);
  assert.deepEqual(calls[0].body.input, [{type:'function_call_output', call_id:'t1', output:'[tool error] boom'}]);
});

test('model names: only OpenAI families cross, and only known levels are suffixes', async () => {
  const {isOpenAIModel, splitModel} = await import('../src/upstream/cross-messages.ts');
  for (const m of ['gpt-5', 'GPT-5.1-codex', 'gpt-4o', 'o3', 'o4-mini', 'chatgpt-4o-latest', 'codex-mini-latest', 'gpt-5(high)', ' gpt-5 ']) assert.equal(isOpenAIModel(m), true, m);
  for (const m of ['claude-opus-5-5', 'claude-3-5-haiku', 'opus', 'omni', 'o', 'my-gpt-5', '', 'sonnet(high)', 7, undefined]) assert.equal(isOpenAIModel(m), false, String(m));
  assert.deepEqual(splitModel('gpt-5.1-codex(XHigh)'), {base:'gpt-5.1-codex', effort:'xhigh'});
  assert.deepEqual(splitModel('gpt-5(turbo)'), {base:'gpt-5(turbo)'});
  assert.deepEqual(splitModel('gpt-5(max)'), {base:'gpt-5', effort:'xhigh'}, 'max means the highest OpenAI level, as in output_config');
});

test('a user cancel releases the slot without resting the account (ADR 0021 2Z)', async () => {
  const a = openaiKey('x-cancel');
  let cancelled = false;
  upstream(() => {
    const head = new TextEncoder().encode(respFrames(textItem('m1', 'hi')).slice(0, 4).map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    return new Response(new ReadableStream({start(c) { c.enqueue(head); }, cancel() { cancelled = true; }}), {status:200, headers:{'content-type':'text/event-stream'}});
  });
  await new Promise((resolve, reject) => {
    const raw = JSON.stringify(claudeBody);
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/messages', method:'POST', agent:false,
      headers:{authorization:'Bearer x1-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(raw)}}, res => { res.once('data', () => { req.destroy(); resolve(); }); });
    req.on('error', () => {}); req.end(raw); setTimeout(() => reject(new Error('no data')), 5000);
  });
  for (let i = 0; i < 100 && (open(a.id) || !cancelled); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(open(a.id), undefined, 'slot released');
  assert.equal(cancelled, true, 'provider stream cancelled');
  assert.equal(restriction(a.id), undefined);
});

test('tool details: forced tool choice, images in tool results, collisions, arguments only at done, odd call ids', async () => {
  openaiKey('x-tools');
  const odd = 'call.with:odd/chars';
  upstream(call => sse(respFrames([
    R('response.output_item.added', {item:{id:'fc_1', type:'function_call', call_id:odd, name:call.body.tools[0].name}}),
    R('response.output_item.done', {item:{id:'fc_1', type:'function_call', call_id:odd, name:call.body.tools[0].name, arguments:'{"x":2}'}}),
  ])));
  const name = 'tool.with.dots';
  const r = await send({model:'gpt-5', max_tokens:10, stream:false, tools:[{name, input_schema:{type:'object'}}], tool_choice:{type:'tool', name},
    messages:[{role:'user', content:[{type:'tool_result', tool_use_id:'t1', content:[{type:'text', text:'see'}, {type:'image', source:{type:'url', url:'https://example.invalid/a.png'}}]}]}]});
  assert.equal(r.status, 200, r.text);
  const body = calls[0].body;
  assert.match(body.tools[0].name, /^tool_with_dots_[0-9a-f]{8}$/);
  assert.deepEqual(body.tool_choice, {type:'function', name:body.tools[0].name});
  assert.deepEqual(body.input, [{type:'function_call_output', call_id:'t1', output:'see'}, {type:'message', role:'user', content:[{type:'input_image', image_url:'https://example.invalid/a.png'}]}]);
  const m = JSON.parse(r.text);
  assert.equal(m.stop_reason, 'tool_use');
  assert.equal(m.content[0].name, name, 'the declared name comes back');
  assert.deepEqual(m.content[0].input, {x:2});
  assert.match(m.content[0].id, /^toolu_[0-9a-f]{24}$/, 'call ids outside the Anthropic id pattern are replaced');
  // 'a.b' becomes 'a_b_<hash>'; a second tool already named exactly that would collide.
  const {createHash} = await import('node:crypto');
  const taken = `a_b_${createHash('sha256').update('a.b').digest('hex').slice(0, 8)}`;
  const before = calls.length;
  const collide = await send({model:'gpt-5', max_tokens:10, tools:[{name:'a.b', input_schema:{type:'object'}}, {name:taken, input_schema:{type:'object'}}], messages:[{role:'user', content:'hi'}]});
  assert.equal(collide.status, 400, collide.text);
  assert.equal(calls.length, before, 'refused before dispatch');
});

test('stream: false with an in-stream provider failure returns the provider status and message', async () => {
  const a = openaiKey('x-json-fail');
  upstream(() => sse([R('response.created', {response:{id:'r', status:'in_progress'}}), R('response.failed', {response:{id:'r', status:'failed', error:{code:'server_error', message:'Try again'}}})]));
  const r = await send({...claudeBody, stream:false});
  assert.equal(r.status, 500);
  assert.deepEqual(JSON.parse(r.text), {type:'error', error:{type:'api_error', message:'Try again'}});
  assert.equal(open(a.id), undefined);
});

test('a provider JSON reply (stream not honoured) is translated too', async () => {
  openaiKey('x-provider-json');
  upstream(() => new Response(JSON.stringify({id:'r', status:'completed', output:[{type:'reasoning', id:'rs'}, {type:'message', id:'m', content:[{type:'output_text', text:'done'}]}], usage:{input_tokens:3, output_tokens:4}}), {status:200, headers:{'content-type':'application/json'}}));
  const r1 = await send({...claudeBody, stream:false});
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual(JSON.parse(r1.text).content, [{type:'text', text:'done'}]);
  const r2 = await send(claudeBody);
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(events(r2.text).map(e => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

test('the client terminal waits for settlement: a failed settlement never shows message_stop', async () => {
  const a = openaiKey('x-settle');
  const frames = respFrames(textItem('m1', 'hi')).map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  upstream(() => new Response(new ReadableStream({async start(c) {
    const enc = new TextEncoder();
    c.enqueue(enc.encode(frames.slice(0, -1).join('')));
    await new Promise(r => setTimeout(r, 50));
    db.prepare('DELETE FROM ordinary_account_attempts WHERE account_id=?').run(a.id); // ownership lost before the terminal
    c.enqueue(enc.encode(frames.at(-1))); c.close();
  }}), {status:200, headers:{'content-type':'text/event-stream'}}));
  const r = await send(claudeBody);
  const ev = events(r.text);
  assert.ok(!ev.some(e => e.event === 'message_stop' || e.event === 'message_delta'), 'no success terminal before durable settlement');
  assert.equal(ev.at(-1).event, 'error');
});

test('stream: parallel calls and text around them keep one open block at a time; empty deltas open nothing', async () => {
  openaiKey('x-parallel');
  upstream(() => sse(respFrames([...textItem('m1', '', 'Let me look.'), ...callItem('fc_1', 'call_1', 'Read', ['{"file_path":"a"}']), ...callItem('fc_2', 'call_2', 'Read', ['{"file_path":"b"}']), ...textItem('m2', 'Done.')]), {'x-codex-primary-used-percent':'40', 'x-ratelimit-remaining-tokens':'1', 'x-request-id':'req_9'}));
  const r = await send(claudeBody);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['x-request-id'], 'req_9');
  assert.equal(r.headers['x-codex-primary-used-percent'], undefined);
  assert.equal(r.headers['x-ratelimit-remaining-tokens'], undefined);
  const ev = events(r.text).map(e => e.data);
  const starts = ev.filter(e => e.type === 'content_block_start');
  assert.deepEqual(starts.map(e => [e.index, e.content_block.type, e.content_block.id ?? null]), [[0, 'text', null], [1, 'tool_use', 'call_1'], [2, 'tool_use', 'call_2'], [3, 'text', null]]);
  let open = -1;
  for (const e of ev) {
    if (e.type === 'content_block_start') { assert.equal(open, -1, 'one block at a time'); open = e.index; }
    if (e.type === 'content_block_delta') assert.equal(e.index, open);
    if (e.type === 'content_block_stop') { assert.equal(e.index, open); open = -1; }
  }
  assert.ok(!ev.some(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta' && !e.delta.text), 'no empty text deltas');
  assert.equal(ev.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('arguments of a call whose block another item already closed fail the stream instead of vanishing', async () => {
  const a = openaiKey('x-interleave');
  upstream(() => sse(respFrames([
    R('response.output_item.added', {item:{id:'fc_1', type:'function_call', call_id:'call_1', name:'Read'}}),
    R('response.output_item.added', {item:{id:'m1', type:'message', content:[]}}),
    R('response.output_text.delta', {item_id:'m1', delta:'hi'}),
    R('response.output_item.done', {item:{id:'fc_1', type:'function_call', call_id:'call_1', name:'Read', arguments:'{"file_path":"a"}'}}),
  ])));
  const r = await send(claudeBody);
  const ev = events(r.text);
  assert.equal(ev.at(-1).event, 'error');
  assert.ok(!ev.some(e => e.event === 'message_stop'));
  assert.equal(open(a.id), undefined);
});

test('request details: images after the run of tool results, tool_choice dropped with no usable tools, effort max, billing marker', async () => {
  openaiKey('x-details');
  upstream(() => sse(respFrames(textItem('m1', 'ok'))));
  const img = {type:'image', source:{type:'base64', media_type:'image/png', data:'AAAA'}};
  const r = await send({model:'gpt-5', max_tokens:10,
    system:[{type:'text', text:'x-anthropic-billing-header: cc_version=9.9'}, {type:'text', text:'Real instructions.'}],
    tools:[{type:'web_search_20250305', name:'web_search'}], tool_choice:{type:'auto', disable_parallel_tool_use:true}, output_config:{effort:'max'},
    messages:[{role:'user', content:[{type:'tool_result', tool_use_id:'a', content:[{type:'text', text:'A'}, img]}, {type:'tool_result', tool_use_id:'b', content:'B'}, {type:'text', text:'go on'}]}]});
  assert.equal(r.status, 200, r.text);
  const body = calls[0].body;
  assert.equal(body.instructions, 'Real instructions.');
  assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.parallel_tool_calls, undefined);
  assert.deepEqual(body.reasoning, {effort:'xhigh'});
  assert.deepEqual(body.input, [
    {type:'function_call_output', call_id:'a', output:'A'},
    {type:'function_call_output', call_id:'b', output:'B'},
    {type:'message', role:'user', content:[{type:'input_image', image_url:'data:image/png;base64,AAAA'}]},
    {type:'message', role:'user', content:[{type:'input_text', text:'go on'}]},
  ]);
});

test('content_filter maps to refusal, and pings flow while the provider sends nothing visible', async () => {
  openaiKey('x-ping');
  const {CROSS_PING} = await import('../src/upstream/cross-messages.ts');
  const saved = CROSS_PING.ms; CROSS_PING.ms = 0;
  try {
    upstream(() => sse(respFrames([...reasoningItem, ...textItem('m1', 'x')], {status:'incomplete', incomplete:'content_filter'})));
    const r = await send(claudeBody);
    const ev = events(r.text);
    assert.ok(ev.some(e => e.event === 'ping' && e.data.type === 'ping'), 'ping while reasoning');
    assert.equal(ev.find(e => e.event === 'message_delta').data.delta.stop_reason, 'refusal');
  } finally { CROSS_PING.ms = saved; }
});

test('an empty first text delta does not shift block indexes: a tool call alone starts at index 0', async () => {
  openaiKey('x-index');
  upstream(() => sse(respFrames([...textItem('m1', ''), ...callItem('fc_1', 'call_1', 'Read', ['{}'])])));
  const r = await send(claudeBody);
  const ev = events(r.text).map(e => e.data).filter(e => e.type.startsWith('content_block'));
  assert.deepEqual(ev.map(e => [e.type, e.index]), [['content_block_start', 0], ['content_block_delta', 0], ['content_block_stop', 0]]);
  assert.equal(ev[0].content_block.type, 'tool_use');
});

test('Claude Code mid-conversation system messages become developer messages in place (Claude Code 2.1.3xx)', async () => {
  codexOauth('x-system');
  upstream(() => sse(respFrames(textItem('m1', 'ok'))));
  const r = await send({model:'gpt-6.1-terra(high)', max_tokens:32000, stream:true, thinking:{type:'adaptive', display:'omitted'}, output_config:{effort:'high'},
    system:[{type:'text', text:'x-anthropic-billing-header: cc_version=2.1.323;'}, {type:'text', text:"You are a Claude agent, built on Anthropic's Claude Agent SDK."}],
    messages:[
      {role:'user', content:[{type:'text', text:'<system-reminder>attribution</system-reminder>'}]},
      {role:'system', content:[{type:'text', text:'# Environment\nPrimary working directory: C:\\w', cache_control:{type:'ephemeral'}}]},
      {role:'user', content:'Run a shell command'},
      {role:'system', content:''},
    ]});
  assert.equal(r.status, 200, r.text);
  const input = calls[0].body.input;
  assert.deepEqual(input.map(i => i.role), ['user', 'developer', 'user']);
  assert.deepEqual(input[1].content, [{type:'input_text', text:'# Environment\nPrimary working directory: C:\\w'}]);
  assert.equal(calls[0].body.reasoning.effort, 'high');
  assert.equal(calls[0].body.instructions, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  upstream(() => { throw new Error('must not dispatch'); });
  const bad = await send({model:'gpt-5', max_tokens:10, messages:[{role:'user', content:'hi'}, {role:'system', content:[{type:'image', source:{type:'base64', media_type:'image/png', data:'AA'}}]}]});
  assert.equal(bad.status, 400);
});

test('tool search references become text and a context overflow reads "prompt is too long" for Claude Code', async () => {
  openaiKey('x-toolref');
  upstream(() => sse(respFrames(textItem('m1', 'ok'))));
  const r = await send({model:'gpt-5', max_tokens:100, tools:[{name:'ToolSearch', input_schema:{type:'object', properties:{}}}, {name:'mcp__fs__read', defer_loading:true, input_schema:{type:'object', properties:{}}}],
    messages:[{role:'user', content:'go'}, {role:'assistant', content:[{type:'tool_use', id:'t1', name:'ToolSearch', input:{query:'fs'}}]},
      {role:'user', content:[{type:'tool_result', tool_use_id:'t1', content:[{type:'tool_reference', tool_name:'mcp__fs__read'}]}]}]});
  assert.equal(r.status, 200, r.text);
  assert.equal(calls[0].body.input.find(i => i.type === 'function_call_output').output, 'Tool loaded: mcp__fs__read');
  assert.deepEqual(calls[0].body.tools.map(t => t.name), ['ToolSearch', 'mcp__fs__read']);
  openaiKey('x-overflow');
  upstream(() => new Response(JSON.stringify({error:{message:'Your input exceeds the context window of this model.', type:'invalid_request_error', code:'context_length_exceeded'}}), {status:400, headers:{'content-type':'application/json'}}));
  const o = await send({model:'gpt-5', max_tokens:100, messages:[{role:'user', content:'hi'}]});
  assert.equal(o.status, 400);
  assert.equal(JSON.parse(o.text).error.message, 'prompt is too long: Your input exceeds the context window of this model.');
});

