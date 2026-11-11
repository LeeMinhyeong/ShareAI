// ADR 0020: API credit exhaustion on passthrough endpoints. Real Express + v1/admin routers over a
// test-owned file SQLite; synthetic fetch only, no real provider or credential.
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
const {default: adminRouter} = await import('../src/routes/admin.ts');
initDatabase();
const db = getDb();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('p5-key'), name:'p5', email:'p5@example.invalid', tier:'pro', dailyLimit:1000});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', router);
app.use('/admin', adminRouter);
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

// ADR 0020: an API-key account whose prepaid credit is exhausted is marked
// `error` with a credit message and leaves routing until an administrator
// re-enables it. The provider error itself is still forwarded unchanged (3B).
const state = id => repo.findById(id);
const json = (status, value, headers = {}) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json', ...headers}});
const msgBody = JSON.stringify({model:'claude-haiku-5-5', max_tokens:5, messages:[{role:'user', content:'x'}]});
const respBody = JSON.stringify({model:'gpt-5.5', input:'x', stream:false});
const anthropicCredit = {type:'error', error:{type:'invalid_request_error', message:'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'}};
const anthropicBilling = {type:'error', error:{type:'billing_error', message:'There is an issue with your billing.'}};
const openaiError = (code, type = 'insufficient_quota') => ({error:{message:'You exceeded your current quota.', type, param:null, code}});
function admin(method, path, value) {
  return new Promise((resolve, reject) => {
    const raw = value === undefined ? '' : JSON.stringify(value);
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method, agent:false,
      headers:{authorization:`Bearer ${'x'.repeat(24)}`, 'content-type':'application/json', 'content-length':Buffer.byteLength(raw)}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, json:JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')}));
    });
    req.on('error', reject); req.end(raw);
  });
}
function assertExhausted(id, code) {
  const a = state(id);
  assert.equal(a.status, 'error');
  assert.match(a.lastError, /API 크레딧 소진/);
  assert.ok(a.lastError.includes(code), a.lastError);
  assert.ok(!open(id), 'attempt settled');
}

test('messages: Anthropic "credit balance is too low" marks the API-key account exhausted and forwards the 400 unchanged', async () => {
  const a = anthropicKey('credit-400');
  upstream(() => json(400, anthropicCredit, {'request-id':'req_c'}));
  const r = await send('/v1/messages', msgBody, claudeHeaders);
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.text), anthropicCredit, 'provider error forwarded unchanged');
  assertExhausted(a.id, 'credit_balance_too_low');
  // Leaves routing: with no other account the next request never reaches the provider.
  upstream(() => { throw new Error('exhausted account must not be dispatched'); });
  const next = await send('/v1/messages', msgBody, claudeHeaders);
  assert.equal(next.status, 503);
  assert.equal(calls.length, 0);
});

test('messages: Anthropic 402 billing_error marks the API-key account exhausted', async () => {
  const a = anthropicKey('credit-402');
  upstream(() => json(402, anthropicBilling));
  const r = await send('/v1/messages', msgBody, claudeHeaders);
  assert.equal(r.status, 402);
  assertExhausted(a.id, 'billing_error');
});

test('messages: other 400s, other messages and subscription accounts are not treated as exhaustion', async () => {
  const a = anthropicKey('plain-400');
  upstream(() => json(400, {type:'error', error:{type:'invalid_request_error', message:'max_tokens: 999999 > 64000, which is the maximum'}}));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
  assert.equal(state(a.id).status, 'active');
  // The credit wording under another error type is not enough.
  upstream(() => json(400, {type:'error', error:{type:'api_error', message:'Your credit balance is too low'}}));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
  assert.equal(state(a.id).status, 'active');
  const o = anthropicOauth('oauth-credit');
  upstream(() => json(400, anthropicCredit));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
  assert.equal(state(o.id).status, 'active', 'subscription OAuth accounts are out of scope');
});

test('responses: OpenAI 429 credit_balance_exhausted marks the API-key account exhausted; the next request uses another account', async () => {
  const spare = openaiKey('spare');
  const a = openaiKey('credit-429');
  repo.update(spare.id, {status:'active'});
  upstream(call => call.headers.authorization === `Bearer sk-credit-429`
    ? json(429, openaiError('credit_balance_exhausted'))
    : json(200, {id:'resp_1', object:'response', status:'completed', output:[], usage:{input_tokens:1, output_tokens:1, total_tokens:2}}));
  // Route the first request to the exhausted account deterministically.
  repo.update(spare.id, {status:'disabled'});
  const r = await send('/v1/responses', respBody);
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.text).error.code, 'credit_balance_exhausted');
  assertExhausted(a.id, 'credit_balance_exhausted');
  repo.update(spare.id, {status:'active'});
  const next = await send('/v1/responses', respBody);
  assert.equal(next.status, 200, next.text);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer sk-spare');
  repo.update(spare.id, {status:'disabled'});
});

test('responses: legacy insufficient_quota and spend-limit codes are exhaustion; an ordinary rate limit is not', async () => {
  for (const [name, code, type] of [['legacy', 'insufficient_quota', 'insufficient_quota'], ['spend', 'project_spend_limit_exceeded', 'insufficient_quota'], ['typeonly', null, 'insufficient_quota']]) {
    const a = openaiKey(`q-${name}`);
    upstream(() => json(429, openaiError(code, type)));
    assert.equal((await send('/v1/responses', respBody)).status, 429);
    assertExhausted(a.id, code ?? 'insufficient_quota');
  }
  const b = openaiKey('rate');
  upstream(() => json(429, openaiError('rate_limit_exceeded', 'requests'), {'retry-after':'7'}));
  assert.equal((await send('/v1/responses', respBody)).status, 429);
  assert.equal(state(b.id).status, 'quota_exceeded', 'ordinary 429 keeps the temporary restriction');
});

test('responses: a response.failed stream frame with insufficient_quota marks the API-key account exhausted', async () => {
  const a = openaiKey('stream-quota');
  const failed = {type:'response.failed', sequence_number:1, response:{id:'resp_f', status:'failed', error:{code:'insufficient_quota', message:'quota'}}};
  upstream(() => sse([ev('response.created', {type:'response.created', sequence_number:0, response:{id:'resp_f', status:'in_progress', output:[]}}), ev('response.failed', failed)]));
  const r = await send('/v1/responses', JSON.stringify({model:'gpt-5.5', input:'x', stream:true}));
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('insufficient_quota'));
  assertExhausted(a.id, 'insufficient_quota');
});

test('admin: re-enabling an exhausted account clears the credit message and returns it to routing', async () => {
  const a = anthropicKey('reenable');
  upstream(() => json(400, anthropicCredit));
  await send('/v1/messages', msgBody, claudeHeaders);
  assertExhausted(a.id, 'credit_balance_too_low');
  const listed = (await admin('GET', '/admin/accounts')).json.accounts.find(x => x.id === a.id);
  assert.equal(listed.status, 'error');
  assert.match(listed.lastError, /API 크레딧 소진/);
  // Only the exact router notice is shown; anything else (which could quote a credential) stays redacted.
  const other = anthropicKey('notice-lookalike');
  repo.update(other.id, {status:'error', lastError:'API 크레딧 소진(sk-ant-api03-SECRET): 크레딧을 충전한 뒤 계정을 다시 켜세요'});
  assert.equal((await admin('GET', '/admin/accounts')).json.accounts.find(x => x.id === other.id).lastError, 'Account error details redacted');
  repo.update(other.id, {status:'disabled'});
  repo.update(a.id, {status:'error'});
  const patched = await admin('PATCH', `/admin/accounts/${a.id}`, {status:'active'});
  assert.equal(patched.status, 200);
  assert.equal(state(a.id).status, 'active');
  assert.equal(state(a.id).lastError, null);
  upstream(() => sse(claudeFrames));
  const r = await send('/v1/messages', msgBody, claudeHeaders);
  assert.equal(r.status, 200, r.text);
  assert.equal(calls.length, 1);
});

// Review deleg_0f47e6b6 follow-ups.
const restrictionRow = id => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);

test('admin: re-enabling an OpenAI account exhausted by a 429 lifts that 429 restriction and starts a new state generation', async () => {
  const a = openaiKey('reenable-429');
  upstream(() => json(429, openaiError('credit_balance_exhausted'), {'retry-after':'3600'}));
  assert.equal((await send('/v1/responses', respBody)).status, 429);
  assertExhausted(a.id, 'credit_balance_exhausted');
  assert.ok(restrictionRow(a.id), 'the 429 itself armed a restriction before the body was read');
  const before = state(a.id).stateRevision;
  const patched = await admin('PATCH', `/admin/accounts/${a.id}`, {status:'active', name:'reenable-429-renamed'});
  assert.equal(patched.status, 200);
  assert.equal(patched.json.account.status, 'active', 'the response reflects the reactivated account');
  assert.equal(patched.json.account.name, 'reenable-429-renamed', 'other fields apply together');
  assert.equal(state(a.id).status, 'active');
  assert.ok(state(a.id).stateRevision > before, 'a new state generation');
  assert.equal(restrictionRow(a.id), undefined, 'manual recovery lifts the credit 429 restriction');
  upstream(() => json(200, {id:'resp_2', object:'response', status:'completed', output:[], usage:{input_tokens:1, output_tokens:1, total_tokens:2}}));
  const r = await send('/v1/responses', respBody);
  assert.equal(r.status, 200, r.text);
  assert.equal(calls.length, 1);
});

test('admin: re-enabling an account for another reason keeps an ordinary 429 restriction', async () => {
  const a = openaiKey('reenable-rate');
  upstream(() => json(429, openaiError('rate_limit_exceeded', 'requests'), {'retry-after':'3600'}));
  assert.equal((await send('/v1/responses', respBody)).status, 429);
  assert.equal(state(a.id).status, 'quota_exceeded');
  repo.update(a.id, {status:'disabled'});
  assert.equal((await admin('PATCH', `/admin/accounts/${a.id}`, {status:'active'})).status, 200);
  assert.equal(state(a.id).status, 'active');
  assert.ok(restrictionRow(a.id), 'only a credit exhaustion restriction is lifted');
});

test('streams: Anthropic error event, Responses error event and response.failed spend-limit codes are exhaustion', async () => {
  const a = anthropicKey('stream-billing');
  const start = ev('message_start', {type:'message_start', message:{id:'msg_s', type:'message', role:'assistant', model:'claude-haiku-5-5', content:[], stop_reason:null, usage:{input_tokens:1, output_tokens:1}}});
  upstream(() => sse([start, ev('error', {type:'error', error:{type:'billing_error', message:'billing'}})]));
  assert.equal((await send('/v1/messages', JSON.stringify({model:'claude-haiku-5-5', max_tokens:5, stream:true, messages:[{role:'user', content:'x'}]}), claudeHeaders)).status, 200);
  assertExhausted(a.id, 'billing_error');
  const created = ev('response.created', {type:'response.created', sequence_number:0, response:{id:'resp_e', status:'in_progress', output:[]}});
  const streamBody = JSON.stringify({model:'gpt-5.5', input:'x', stream:true});
  const b = openaiKey('stream-error-event');
  upstream(() => sse([created, ev('error', {type:'error', sequence_number:1, code:'credit_balance_exhausted', message:'no credit', param:null})]));
  assert.equal((await send('/v1/responses', streamBody)).status, 200);
  assertExhausted(b.id, 'credit_balance_exhausted');
  const c = openaiKey('stream-spend');
  upstream(() => sse([created, ev('response.failed', {type:'response.failed', sequence_number:1, response:{id:'resp_e', status:'failed', error:{code:'project_spend_limit_exceeded', message:'limit'}}})]));
  assert.equal((await send('/v1/responses', streamBody)).status, 200);
  assertExhausted(c.id, 'project_spend_limit_exceeded');
});

test('admin: an exhausted account an administrator disabled first still gets its credit 429 restriction lifted on re-enable', async () => {
  const a = openaiKey('exhausted-then-disabled');
  upstream(() => json(429, openaiError('credit_balance_exhausted'), {'retry-after':'not-a-date'}));
  assert.equal((await send('/v1/responses', respBody)).status, 429);
  assertExhausted(a.id, 'credit_balance_exhausted');
  assert.equal(restrictionRow(a.id)?.duration_ms, null, 'an unusable Retry-After arms an indefinite restriction');
  assert.equal((await admin('PATCH', `/admin/accounts/${a.id}`, {status:'disabled'})).status, 200);
  assert.equal((await admin('PATCH', `/admin/accounts/${a.id}`, {status:'active'})).status, 200);
  assert.equal(state(a.id).status, 'active');
  assert.equal(restrictionRow(a.id), undefined);
});

test('repository: a failure observed before re-enabling cannot disable the account again', () => {
  const a = openaiKey('stale-observation');
  const notice = 'API 크레딧 소진(credit_balance_exhausted): 크레딧을 충전한 뒤 계정을 다시 켜세요';
  // Two requests observed the same active generation; the first one's result disables the account
  // (a request result does not start a new generation).
  const observed = repo.findById(a.id);
  assert.equal(repo.recordObservedFailure(a.id, 429, notice, observed, undefined, db, 'error'), true);
  assert.equal(state(a.id).status, 'error');
  assert.equal(state(a.id).stateRevision, observed.stateRevision);
  assert.equal(repo.reactivate(a.id), true);
  assert.ok(state(a.id).stateRevision > observed.stateRevision, 're-enabling starts a new generation');
  assert.equal(repo.recordObservedFailure(a.id, 429, notice, observed, undefined, db, 'error'), false, 'the second, older result is ignored');
  assert.equal(state(a.id).status, 'active');
  assert.equal(state(a.id).lastError, null);
  assert.equal(repo.reactivate(a.id), false, 'an active account is left alone');
});
