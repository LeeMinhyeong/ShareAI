// ADR 0023: Codex (/v1/responses) with a Claude model name is translated to the Messages API and served
// by Anthropic accounts (API key, Claude subscription OAuth). Real Express + v1 router (auth, quota,
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
const {encodeReasoning, decodeReasoning, isClaudeModel} = await import('../src/upstream/cross-responses.ts');
const {default: router} = await import('../src/routes/v1.ts');
initDatabase();
const db = getDb();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('x2-key'), name:'x2', email:'x2@example.invalid', tier:'pro', dailyLimit:1000});
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
const anthropicKey = name => account(name, 'anthropic', 'api_key', 'sk-ant-api03-' + name.replace(/[^A-Za-z0-9]/g, '') + 'k'.repeat(20));
const claudeOauth = name => account(name, 'anthropic', 'oauth', JSON.stringify({kind:'oauth', accessToken:`oat-${name}`, refreshToken:`ort-${name}`, expiresAt:Date.now() + 3600_000}));
const openaiKey = name => account(name, 'openai', 'api_key', `sk-${name}`);
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
const A = (type, extra = {}) => ({type, ...extra});
const sse = (events, headers = {}) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {status:200, headers:{'content-type':'text/event-stream', ...headers}});
function send(body) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/responses', method:'POST', agent:false,
      headers:{authorization:'Bearer x2-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(raw), originator:'codex_cli_rs', 'user-agent':'codex_cli_rs/9.9', session_id:'s1'}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(raw);
  });
}
const events = text => text.split('\n\n').filter(Boolean).map(f => { const [e, d] = f.split('\n'); return {event:e.slice(7), data:JSON.parse(d.slice(6))}; });

const msgStart = (usage = {input_tokens:10, cache_creation_input_tokens:2, cache_read_input_tokens:5, output_tokens:1}) => A('message_start', {message:{id:'msg_1', type:'message', role:'assistant', model:'claude-sonnet-4-5', content:[], stop_reason:null, usage}});
const block = (index, content_block, deltas) => [A('content_block_start', {index, content_block}), ...deltas.map(delta => A('content_block_delta', {index, delta})), A('content_block_stop', {index})];
const msgEnd = (stop = 'end_turn', output = 7) => [A('message_delta', {delta:{stop_reason:stop, stop_sequence:null}, usage:{output_tokens:output}}), A('message_stop')];
const textReply = text => [msgStart(), ...block(0, {type:'text', text:''}, [{type:'text_delta', text}]), ...msgEnd()];

const grammar = 'start: begin_patch hunk+ end_patch';
const codexTools = [
  {type:'function', name:'shell', description:'Run', strict:false, parameters:{type:'object', properties:{command:{type:'array', items:{type:'string'}}}, required:['command']}},
  {type:'custom', name:'apply_patch', description:'Edit files', format:{type:'grammar', syntax:'lark', definition:grammar}},
  {type:'namespace', name:'mcp__fs', description:'Files', tools:[{type:'function', name:'list', description:'List', parameters:{type:'object', properties:{}}}]},
  {type:'web_search'}, {type:'local_shell'},
];
const envelope = encodeReasoning([{type:'thinking', thinking:'plan', signature:'sig1'}]);
const codexBody = {
  model:'claude-sonnet-4-5', instructions:'You are Codex.', stream:true, store:false, include:['reasoning.encrypted_content'], prompt_cache_key:'pk', text:{verbosity:'medium'},
  reasoning:{effort:'xhigh', summary:'auto'}, tool_choice:'auto', parallel_tool_calls:false, tools:codexTools,
  input:[
    {type:'message', role:'developer', content:[{type:'input_text', text:'<permissions>'}]},
    {type:'message', role:'user', content:[{type:'input_text', text:'fix a.txt'}, {type:'input_image', image_url:'data:image/png;base64,AAAA'}]},
    {type:'reasoning', id:'rs_old', summary:[{type:'summary_text', text:'old'}], encrypted_content:'gAAAAB-openai-ciphertext'},
    {type:'reasoning', id:'rs_1', summary:[{type:'summary_text', text:'plan'}], encrypted_content:envelope},
    {type:'message', role:'assistant', content:[{type:'output_text', text:'Looking.'}]},
    {type:'function_call', call_id:'call_1', name:'shell', arguments:'{"command":["cat","a.txt"]}'},
    {type:'function_call_output', call_id:'call_1', output:'hello'},
    {type:'custom_tool_call', call_id:'call_2', name:'apply_patch', input:'*** Begin Patch\n*** End Patch'},
    {type:'custom_tool_call_output', call_id:'call_2', output:'Done'},
    {type:'function_call', call_id:'call_3', name:'list', namespace:'mcp__fs', arguments:'{}'},
    {type:'function_call_output', call_id:'call_3', output:[{type:'input_text', text:'a.txt'}]},
    {type:'message', role:'user', content:[{type:'input_text', text:'thanks'}]},
  ],
};
const CC = {type:'ephemeral'};

test('a GPT model on /v1/responses still goes to OpenAI unchanged', async () => {
  openaiKey('y-gpt');
  upstream(() => new Response(JSON.stringify({error:{message:'stop'}}), {status:400, headers:{'content-type':'application/json'}}));
  const r = await send({...codexBody, model:'gpt-5.1-codex'});
  assert.equal(r.status, 400);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
});

test('API key: the Codex request is translated to the Messages API', async () => {
  const a = anthropicKey('y-key');
  upstream(() => sse(textReply('ok')));
  const r = await send(codexBody);
  assert.equal(r.status, 200, r.text);
  const c = calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.match(c.headers['x-api-key'], /^sk-ant-api03-/);
  assert.equal(c.headers.authorization, undefined);
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  for (const h of ['originator', 'session_id', 'user-agent']) assert.equal(c.headers[h], undefined, `${h} is not sent`);
  assert.deepEqual(c.body, {
    model:'claude-sonnet-4-5', max_tokens:32000,
    system:[{type:'text', text:'You are Codex.'}, {type:'text', text:'<permissions>', cache_control:CC}],
    messages:[
      {role:'user', content:[{type:'text', text:'fix a.txt'}, {type:'image', source:{type:'base64', media_type:'image/png', data:'AAAA'}}]},
      {role:'assistant', content:[{type:'thinking', thinking:'plan', signature:'sig1'}, {type:'text', text:'Looking.'}, {type:'tool_use', id:'call_1', name:'shell', input:{command:['cat', 'a.txt']}}]},
      {role:'user', content:[{type:'tool_result', tool_use_id:'call_1', content:'hello'}]},
      {role:'assistant', content:[{type:'tool_use', id:'call_2', name:'apply_patch', input:{input:'*** Begin Patch\n*** End Patch'}}]},
      {role:'user', content:[{type:'tool_result', tool_use_id:'call_2', content:'Done', cache_control:CC}]},
      {role:'assistant', content:[{type:'tool_use', id:'call_3', name:'mcp__fs__list', input:{}}]},
      {role:'user', content:[{type:'tool_result', tool_use_id:'call_3', content:[{type:'text', text:'a.txt'}]}, {type:'text', text:'thanks', cache_control:CC}]},
    ],
    tools:[
      {name:'shell', description:'Run', input_schema:codexTools[0].parameters},
      {name:'apply_patch', description:`Edit files\n\nThe input is raw text (not JSON) in this lark grammar:\n${grammar}`, input_schema:{type:'object', properties:{input:{type:'string', description:'The raw tool input, exactly as the tool description specifies.'}}, required:['input']}},
      {name:'mcp__fs__list', description:'List', input_schema:{type:'object', properties:{}}, cache_control:CC},
    ],
    tool_choice:{type:'auto', disable_parallel_tool_use:true},
    thinking:{type:'adaptive'}, output_config:{effort:'max'}, stream:true,
  });
  assert.equal(open(a.id), undefined);
  assert.deepEqual({...usage(a.id)}, {input:17, output:7, success:1, model:'claude-sonnet-4-5', provider:'anthropic'});
});

test('stream: thinking, text, a freeform call and a namespaced call come back as Codex events', async () => {
  anthropicKey('y-stream');
  upstream(() => sse([msgStart(),
    ...block(0, {type:'thinking', thinking:'', signature:''}, [{type:'thinking_delta', thinking:'think'}, {type:'signature_delta', signature:'SIG'}]),
    ...block(1, {type:'text', text:''}, [{type:'text_delta', text:'Hi'}]),
    ...block(2, {type:'tool_use', id:'toolu_A', name:'apply_patch', input:{}}, [{type:'input_json_delta', partial_json:'{"input":"*** Begin'}, {type:'input_json_delta', partial_json:' Patch"}'}]),
    ...block(3, {type:'tool_use', id:'toolu_B', name:'mcp__fs__list', input:{}}, [{type:'input_json_delta', partial_json:'{}'}]),
    A('ping'), ...msgEnd('tool_use')]));
  const r = await send(codexBody);
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  const ev = events(r.text);
  for (const e of ev) assert.equal(e.event, e.data.type);
  assert.deepEqual(ev.map(e => e.event), [
    'response.created', 'response.in_progress',
    'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
    'response.output_item.added', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done', 'response.output_item.done',
    'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done',
    'response.completed']);
  assert.deepEqual(ev.map(e => e.data.sequence_number), ev.map((_, i) => i));
  assert.equal(ev[0].data.response.model, 'claude-sonnet-4-5');
  const done = ev.filter(e => e.event === 'response.output_item.done').map(e => e.data.item);
  assert.deepEqual(done[0].summary, [{type:'summary_text', text:'think'}]);
  assert.deepEqual(decodeReasoning(done[0].encrypted_content), [{type:'thinking', thinking:'think', signature:'SIG'}]);
  assert.equal(JSON.parse(Buffer.from(done[0].encrypted_content.slice(5), 'base64').toString()).model, 'claude-sonnet-4-5', 'the envelope records the model');
  assert.equal(decodeReasoning(done[0].encrypted_content, 'claude-opus-5-5'), undefined);
  assert.deepEqual(done[1].content, [{type:'output_text', text:'Hi', annotations:[]}]);
  assert.equal(done[2].type, 'custom_tool_call'); assert.equal(done[2].name, 'apply_patch'); assert.equal(done[2].call_id, 'toolu_A'); assert.equal(done[2].input, '*** Begin Patch');
  assert.equal(done[3].type, 'function_call'); assert.equal(done[3].name, 'list'); assert.equal(done[3].namespace, 'mcp__fs'); assert.equal(done[3].arguments, '{}');
  const completed = ev.at(-1).data.response;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.usage, {input_tokens:17, input_tokens_details:{cached_tokens:5}, output_tokens:7, output_tokens_details:{reasoning_tokens:0}, total_tokens:24});
  assert.deepEqual(completed.output.map(i => i.type), ['reasoning', 'message', 'custom_tool_call', 'function_call']);

  // Decision 1: the reasoning item Codex sends back restores the signed thinking block.
  upstream(() => sse(textReply('next')));
  await send({...codexBody, input:[{type:'message', role:'user', content:'go'}, done[0], done[2], {type:'custom_tool_call_output', call_id:'toolu_A', output:'ok'}]});
  assert.deepEqual(calls[0].body.messages[1].content, [{type:'thinking', thinking:'think', signature:'SIG'}, {type:'tool_use', id:'toolu_A', name:'apply_patch', input:{input:'*** Begin Patch'}}]);
});

test('Claude subscription: Claude Code identity first and the chat-path headers', async () => {
  const a = claudeOauth('y-oauth');
  upstream(() => sse(textReply('ok')));
  const r = await send({model:'claude-opus-5-5', input:'hi', stream:true});
  assert.equal(r.status, 200, r.text);
  const c = calls[0];
  assert.equal(c.headers.authorization, 'Bearer oat-y-oauth');
  assert.equal(c.headers['x-api-key'], undefined);
  assert.equal(c.headers['anthropic-beta'], 'claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20');
  assert.equal(c.headers['user-agent'], 'claude-cli/2.1.0');
  assert.deepEqual(c.body.system, [{type:'text', text:"You are Claude Code, Anthropic's official CLI for Claude.", cache_control:CC}]);
  assert.deepEqual(c.body.messages, [{role:'user', content:[{type:'text', text:'hi', cache_control:CC}]}]);
  assert.deepEqual(c.body.thinking, {type:'adaptive'});
  assert.equal(c.body.output_config, undefined, 'no level: model default');
  assert.equal(open(a.id), undefined);
});

test('reasoning level: suffix wins, Codex levels map onto Claude effort, none or a forced tool turns thinking off', async () => {
  anthropicKey('y-effort');
  upstream(() => sse(textReply('ok')));
  const base = {model:'claude-sonnet-4-5', input:'hi', tools:[codexTools[0]]};
  const sent = async body => { await send(body); return calls.at(-1).body; };
  assert.deepEqual((await sent({...base, reasoning:{effort:'minimal'}})).output_config, {effort:'low'});
  assert.deepEqual((await sent({...base, reasoning:{effort:'medium'}})).output_config, {effort:'medium'});
  assert.deepEqual((await sent({...base, model:'claude-sonnet-4-5(high)', reasoning:{effort:'low'}})).output_config, {effort:'high'});
  assert.equal((await sent({...base, model:'claude-sonnet-4-5(high)'})).model, 'claude-sonnet-4-5');
  const none = await sent({...base, reasoning:{effort:'none'}});
  assert.equal(none.thinking, undefined); assert.equal(none.output_config, undefined);
  const forced = await sent({...base, reasoning:{effort:'high'}, tool_choice:'required'});
  assert.equal(forced.thinking, undefined); assert.deepEqual(forced.tool_choice, {type:'any'}); assert.deepEqual(forced.output_config, {effort:'high'});
  const named = await sent({...base, tool_choice:{type:'function', name:'shell'}});
  assert.deepEqual(named.tool_choice, {type:'tool', name:'shell'}); assert.equal(named.thinking, undefined);
  assert.equal((await sent({...base, max_output_tokens:500})).max_tokens, 500);
});

test('content that would be lost is refused with 400 before any provider call', async () => {
  const a = anthropicKey('y-reject');
  upstream(() => { throw new Error('must not dispatch'); });
  for (const input of [
    [{type:'message', role:'user', content:[{type:'input_file', file_data:'data:application/pdf;base64,JVBE', filename:'a.pdf'}]}],
    [{type:'message', role:'user', content:'hi'}, {type:'computer_call', id:'cc', call_id:'c', action:{type:'click'}}],
    [{type:'message', role:'user', content:'hi'}, {type:'compaction_trigger'}],
    [{type:'message', role:'user', content:'hi'}, {type:'function_call', call_id:'c', name:'shell', arguments:'{not json'}],
    [{type:'message', role:'assistant', content:[{type:'output_text', text:'first'}]}],
  ]) {
    const r = await send({model:'claude-sonnet-4-5', input});
    assert.equal(r.status, 400, r.text);
    assert.equal(typeof JSON.parse(r.text).error.message, 'string');
  }
  assert.equal((await send({model:'claude-sonnet-4-5', input:'hi', previous_response_id:'resp_1'})).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(open(a.id), undefined);
});

test('provider HTTP errors keep status and message in the Responses envelope; 429 rests the account', async () => {
  const a = anthropicKey('y-429');
  upstream(() => new Response(JSON.stringify({type:'error', error:{type:'rate_limit_error', message:'Number of request tokens has exceeded your rate limit'}}), {status:429, headers:{'content-type':'application/json', 'retry-after':'9', 'anthropic-ratelimit-requests-remaining':'0', 'anthropic-organization-id':'org-pool', 'request-id':'req_7'}}));
  const r = await send(codexBody);
  assert.equal(r.status, 429);
  assert.deepEqual(JSON.parse(r.text), {error:{message:'Number of request tokens has exceeded your rate limit', type:'rate_limit_error', code:'rate_limit_exceeded', param:null}});
  assert.equal(r.headers['retry-after'], '9');
  assert.equal(r.headers['request-id'], 'req_7');
  assert.equal(r.headers['anthropic-ratelimit-requests-remaining'], undefined);
  assert.equal(r.headers['anthropic-organization-id'], undefined);
  assert.ok(restriction(a.id));
  anthropicKey('y-400');
  upstream(() => new Response(JSON.stringify({type:'error', error:{type:'invalid_request_error', message:'prompt is too long: 250000 tokens > 200000 maximum'}}), {status:400, headers:{'content-type':'application/json'}}));
  const long = await send(codexBody);
  assert.equal(long.status, 400);
  assert.equal(JSON.parse(long.text).error.code, 'context_length_exceeded', 'Codex can react to a context overflow');
});

test('an in-stream provider error becomes response.failed and the account rests', async () => {
  const a = anthropicKey('y-overloaded');
  upstream(() => sse([msgStart(), ...block(0, {type:'text', text:''}, [{type:'text_delta', text:'par'}]), A('error', {error:{type:'overloaded_error', message:'Overloaded'}})]));
  const r = await send(codexBody);
  assert.equal(r.status, 200);
  const ev = events(r.text);
  const last = ev.at(-1);
  assert.equal(last.event, 'response.failed');
  assert.deepEqual(last.data.response.error, {code:'server_is_overloaded', message:'Overloaded'});
  assert.ok(!ev.some(e => e.event === 'response.completed'));
  assert.ok(restriction(a.id), '529 is a provider failure');
  assert.equal(open(a.id), undefined);
});

test('blocks Codex cannot represent, or unsigned thinking, end the stream with an error', async () => {
  for (const reply of [
    [msgStart(), ...block(0, {type:'server_tool_use', id:'srv', name:'web_search', input:{}}, []), ...msgEnd()],
    [msgStart(), ...block(0, {type:'thinking', thinking:'', signature:''}, [{type:'thinking_delta', thinking:'x'}]), ...msgEnd()],
  ]) {
    const a = anthropicKey(`y-unknown-${reply.length}`);
    upstream(() => sse(reply));
    const r = await send(codexBody);
    const ev = events(r.text);
    assert.equal(ev.at(-1).event, 'response.failed', 'Codex reads response.failed');
    assert.equal(ev.at(-1).data.response.error.code, 'server_error');
    assert.ok(!ev.some(e => e.event === 'response.completed'));
    assert.equal(open(a.id), undefined);
  }
});

test('stream: false returns one Response object; max_tokens and refusal end as incomplete', async () => {
  anthropicKey('y-json');
  upstream(() => sse([msgStart(), ...block(0, {type:'text', text:''}, [{type:'text_delta', text:'partial'}]), ...msgEnd('max_tokens')]));
  const r = await send({...codexBody, stream:false});
  assert.equal(r.status, 200, r.text);
  const resp = JSON.parse(r.text);
  assert.equal(resp.object, 'response'); assert.equal(resp.status, 'incomplete');
  assert.deepEqual(resp.incomplete_details, {reason:'max_output_tokens'});
  assert.deepEqual(resp.output.map(i => i.type), ['message']);
  assert.equal(calls[0].body.stream, true, 'the provider is always asked for a stream');
  upstream(() => sse([msgStart(), ...msgEnd('refusal')]));
  const ref = events((await send(codexBody)).text).at(-1);
  assert.equal(ref.event, 'response.incomplete');
  assert.deepEqual(ref.data.response.incomplete_details, {reason:'content_filter'});
});

test('the client terminal waits for settlement: a failed settlement never shows response.completed', async () => {
  const a = anthropicKey('y-settle');
  const frames = textReply('hi').map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  upstream(() => new Response(new ReadableStream({async start(c) {
    const enc = new TextEncoder();
    c.enqueue(enc.encode(frames.slice(0, -1).join('')));
    await new Promise(r => setTimeout(r, 50));
    db.prepare('DELETE FROM ordinary_account_attempts WHERE account_id=?').run(a.id);
    c.enqueue(enc.encode(frames.at(-1))); c.close();
  }}), {status:200, headers:{'content-type':'text/event-stream'}}));
  const ev = events((await send(codexBody)).text);
  assert.ok(!ev.some(e => e.event === 'response.completed'));
  assert.equal(ev.at(-1).event, 'response.failed');
});

test('a user cancel releases the slot without resting the account (ADR 0021 2Z)', async () => {
  const a = anthropicKey('y-cancel');
  let cancelled = false;
  upstream(() => {
    const head = new TextEncoder().encode([msgStart(), A('content_block_start', {index:0, content_block:{type:'text', text:''}}), A('content_block_delta', {index:0, delta:{type:'text_delta', text:'hi'}})].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    return new Response(new ReadableStream({start(c) { c.enqueue(head); }, cancel() { cancelled = true; }}), {status:200, headers:{'content-type':'text/event-stream'}});
  });
  await new Promise((resolve, reject) => {
    const raw = JSON.stringify(codexBody);
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/responses', method:'POST', agent:false,
      headers:{authorization:'Bearer x2-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(raw)}}, res => { res.once('data', () => { req.destroy(); resolve(); }); });
    req.on('error', () => {}); req.end(raw); setTimeout(() => reject(new Error('no data')), 5000);
  });
  for (let i = 0; i < 100 && (open(a.id) || !cancelled); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(open(a.id), undefined);
  assert.equal(cancelled, true);
  assert.equal(restriction(a.id), undefined);
});

test('ordering: tool results go first in their user message; later developer text follows; bad envelopes are dropped', async () => {
  anthropicKey('y-order');
  upstream(() => sse(textReply('ok')));
  await send({model:'claude-sonnet-4-5', input:[
    {role:'user', content:'run'},
    {type:'function_call', call_id:'c.1', name:'shell', arguments:'{"command":["ls"]}'},
    {type:'message', role:'developer', content:[{type:'input_text', text:'approval granted'}]},
    {type:'function_call_output', call_id:'c.1', output:'a.txt'},
    {type:'reasoning', encrypted_content:'srx1:' + Buffer.from('{"v":1,"blocks":[{"type":"thinking","thinking":"x"}]}').toString('base64')},
    {type:'message', role:'assistant', content:[{type:'output_text', text:'done'}]},
    {type:'message', role:'user', content:'ok'},
  ]});
  const m = calls[0].body.messages;
  const id = m[1].content[0].id;
  assert.match(id, /^toolu_[0-9a-f]{24}$/, 'call ids outside the Anthropic pattern are replaced');
  assert.deepEqual(m[2].content.map(b => b.type), ['tool_result', 'text']);
  assert.equal(m[2].content[0].tool_use_id, id, 'call and result keep the same replacement');
  assert.equal(m[2].content[1].text, 'approval granted');
  assert.deepEqual(m[3].content, [{type:'text', text:'done'}], 'an unsigned envelope is not replayed');
});

test('model names: only claude- names cross; levels are suffixes', () => {
  for (const m of ['claude-sonnet-4-5', 'Claude-Opus-5-5', 'claude-haiku-4-5(low)', 'claude-x(max)']) assert.equal(isClaudeModel(m), true, m);
  for (const m of ['gpt-5', 'sonnet', 'my-claude-model', '', 7, undefined]) assert.equal(isClaudeModel(m), false, String(m));
});

test('signed thinking is replayed only to the model that made it, and a continued GPT turn runs without thinking', async () => {
  anthropicKey('y-switch');
  upstream(() => sse(textReply('ok')));
  const fromOpus = encodeReasoning([{type:'thinking', thinking:'t', signature:'S'}], 'claude-opus-5-5');
  const call = {type:'function_call', call_id:'c1', name:'shell', arguments:'{"command":["ls"]}'};
  const result = {type:'function_call_output', call_id:'c1', output:'aborted'};
  await send({model:'claude-opus-5-5(high)', tools:[codexTools[0]], input:[{role:'user', content:'go'}, {type:'reasoning', encrypted_content:fromOpus}, call, result]});
  let body = calls.at(-1).body;
  assert.equal(body.messages[1].content[0].type, 'thinking', 'same model: replayed');
  assert.deepEqual(body.thinking, {type:'adaptive'});
  await send({model:'claude-sonnet-4-5(high)', tools:[codexTools[0]], input:[{role:'user', content:'go'}, {type:'reasoning', encrypted_content:fromOpus}, call, result]});
  body = calls.at(-1).body;
  assert.equal(body.messages[1].content[0].type, 'tool_use', 'another model: dropped');
  assert.equal(body.thinking, undefined, 'the continued turn has no thinking, so this request runs without it');
  assert.deepEqual(body.output_config, {effort:'high'}, 'the level is kept without thinking');
  await send({model:'claude-sonnet-4-5(high)', tools:[codexTools[0]], input:[{role:'user', content:'go'}, call, result, {type:'message', role:'assistant', content:[{type:'output_text', text:'done'}]}, {role:'user', content:'next'}]});
  assert.deepEqual(calls.at(-1).body.thinking, {type:'adaptive'}, 'a fresh user turn turns thinking back on');
});

test('request hygiene: whitespace text, empty developer text, none with parallel off, web_search history, object schemas', async () => {
  anthropicKey('y-hygiene');
  upstream(() => sse(textReply('ok')));
  await send({model:'claude-sonnet-4-5', tool_choice:'none', parallel_tool_calls:false,
    tools:[{type:'function', name:'f', parameters:{properties:{a:{type:'string'}}}}],
    input:[{type:'message', role:'developer', content:[{type:'input_text', text:'  '}]}, {role:'user', content:[{type:'input_text', text:'hi'}, {type:'input_text', text:' \n'}]},
      {type:'web_search_call', id:'ws', status:'completed', action:{type:'search', query:'x'}}, {type:'message', role:'assistant', content:[{type:'output_text', text:'found'}]}, {role:'user', content:'ok'}]});
  const b = calls.at(-1).body;
  assert.equal(b.system, undefined, 'no empty system block');
  assert.deepEqual(b.messages.map(m => m.content.map(c => c.text)), [['hi'], ['found'], ['ok']]);
  assert.deepEqual(b.tool_choice, {type:'none'});
  assert.equal(b.tools[0].input_schema.type, 'object');
  for (const bad of [{text:{format:{type:'json_schema', name:'x', schema:{type:'object'}}}}, {reasoning:{effort:'turbo'}}, {tools:[{type:'function', name:'g', parameters:{type:'string'}}]}]) {
    const r = await send({model:'claude-sonnet-4-5', input:'hi', ...bad});
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('stream: false keeps only the terminal response and a router failure on an open stream is response.failed', async () => {
  anthropicKey('y-json2');
  upstream(() => sse([msgStart(), ...block(0, {type:'text', text:''}, [{type:'text_delta', text:'a'}, {type:'text_delta', text:'b'}]), ...msgEnd()]));
  const r = await send({...codexBody, stream:false});
  assert.deepEqual(JSON.parse(r.text).output[0].content, [{type:'output_text', text:'ab', annotations:[]}]);
  anthropicKey('y-truncated');
  upstream(() => sse([msgStart(), ...block(0, {type:'text', text:''}, [{type:'text_delta', text:'a'}])]));
  const ev = events((await send(codexBody)).text);
  assert.equal(ev.at(-1).event, 'response.failed');
});

test('boundaries: whitespace-only and envelope-only turns vanish without empty messages; GPT reasoning and verbosity pass', async () => {
  anthropicKey('y-bounds');
  upstream(() => sse(textReply('ok')));
  const r = await send({model:'claude-sonnet-4-5', text:{verbosity:'low'}, reasoning:{effort:'minimal'}, input:[
    {role:'user', content:'a'},
    {type:'reasoning', encrypted_content:encodeReasoning([{type:'thinking', thinking:'t', signature:'S'}], 'claude-opus-5-5')},
    {type:'reasoning', encrypted_content:'gAAAA-openai'},
    {type:'message', role:'assistant', content:[{type:'output_text', text:'  '}]},
    {role:'user', content:'b'},
  ]});
  assert.equal(r.status, 200, r.text);
  const b = calls.at(-1).body;
  assert.deepEqual(b.messages, [{role:'user', content:[{type:'text', text:'a'}, {type:'text', text:'b', cache_control:CC}]}]);
  assert.deepEqual(b.output_config, {effort:'low'});
  assert.deepEqual(b.thinking, {type:'adaptive'});
});

test('the Codex 0.167 request shape: no instructions, developer messages, client_metadata, namespace and freeform tools', async () => {
  anthropicKey('y-codex167');
  upstream(() => sse(textReply('ok')));
  const r = await send({model:'claude-opus-5-5', stream:true, store:false, tool_choice:'auto', parallel_tool_calls:true, include:['reasoning.encrypted_content'],
    prompt_cache_key:'01a1-thread', reasoning:{effort:'high', summary:'auto'}, client_metadata:{thread_id:'01a1-thread', 'x-codex-turn-metadata':'{}'},
    tools:[codexTools[0], codexTools[1], {type:'namespace', name:'multi_agent_v1', description:'agents', tools:[{type:'function', name:'spawn_agent', parameters:{type:'object', properties:{}}}]}, {type:'web_search'}],
    input:[
      {type:'message', role:'developer', content:[{type:'input_text', text:'You are Codex, an agent based on Claude.'}]},
      {type:'message', role:'developer', content:[{type:'input_text', text:'<permissions>'}, {type:'input_text', text:'<skills>'}]},
      {type:'message', role:'user', content:[{type:'input_text', text:'<environment_context>'}]},
      {type:'message', role:'user', content:[{type:'input_text', text:'Say hi'}]},
    ]});
  assert.equal(r.status, 200, r.text);
  const b = calls[0].body;
  assert.deepEqual(b.system.map(s => s.text), ['You are Codex, an agent based on Claude.', '<permissions>\n<skills>']);
  assert.deepEqual(b.messages, [{role:'user', content:[{type:'text', text:'<environment_context>'}, {type:'text', text:'Say hi', cache_control:CC}]}]);
  assert.deepEqual(b.tools.map(t => t.name), ['shell', 'apply_patch', 'multi_agent_v1__spawn_agent']);
  assert.deepEqual(b.output_config, {effort:'high'});
  assert.equal(b.client_metadata, undefined);
});

