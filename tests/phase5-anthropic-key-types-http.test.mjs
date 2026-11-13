// Anthropic API key types (personal sk-ant-usr-, legacy workspace sk-ant-api...) on import and dispatch. Real Express + v1/admin routers over a
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

import {readFileSync} from 'node:fs';
// Synthetic values only; assembled from parts so no key-shaped literal lives in the repository.
const key = (kind, fill = 'x') => ['sk', 'ant', kind, fill.repeat(40)].join('-');
const msgBody = JSON.stringify({model:'claude-haiku-5-5', max_tokens:5, messages:[{role:'user', content:'x'}]});
const importAccount = (name, credentials) => admin('POST', '/admin/accounts/import', {name, provider:'anthropic', credentials});
const state = id => repo.findById(id);
const json = (status, value) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json'}});
function only(id) { for (const a of repo.findAll()) repo.update(a.id, {status: a.id === id ? 'active' : 'disabled'}); }

test('import: a personal Claude API key (sk-ant-usr-) is stored as an API key and sent as x-api-key on /v1/messages', async () => {
  const personal = key('usr', 'p');
  const r = await importAccount('personal-key', personal);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.account.credentialType, 'api_key');
  only(r.json.account.id);
  upstream(() => sse(claudeFrames));
  const res = await send('/v1/messages', msgBody, claudeHeaders);
  assert.equal(res.status, 200, res.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-api-key'], personal);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].headers['anthropic-beta'], claudeHeaders['anthropic-beta'], 'no OAuth beta is merged for an API key');
});

test('import: a legacy workspace key (sk-ant-api03-) and a future key kind keep working as API keys', async () => {
  // `svc01` is a made-up kind: the policy is that an unknown `sk-ant-` kind is accepted as an API key
  // (the official docs list no per-kind prefixes), not that such a prefix exists.
  for (const [name, kind] of [['legacy', 'api03'], ['service', 'svc01']]) {
    const r = await importAccount(`key-${name}`, key(kind, 'k'));
    assert.equal(r.status, 201, name);
    assert.equal(r.json.account.credentialType, 'api_key', name);
  }
});

test('import: a setup-token (sk-ant-oat) stays a subscription OAuth credential', async () => {
  const token = key('oat01', 't');
  const r = await importAccount('setup-token', token);
  assert.equal(r.status, 201);
  assert.equal(r.json.account.credentialType, 'oauth');
  only(r.json.account.id);
  upstream(() => sse(claudeFrames));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 200);
  assert.equal(calls[0].headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].headers['x-api-key'], undefined);
});

test('import: an Admin API key and a bare refresh token are refused', async () => {
  const before = repo.findAll().length;
  for (const kind of ['admin01', 'ort01', 'sid01']) assert.equal((await importAccount(`bad-${kind}`, key(kind, 'a'))).status, 400, kind);
  // Malformed pastes: a bare prefix, an embedded line break, two keys at once, trailing junk.
  const good = key('usr', 'g');
  for (const [name, text] of [['bare', 'sk-ant-'], ['newline', good.slice(0, 20) + '\n' + good.slice(20)], ['two', `${good} ${key('usr', 'h')}`], ['junk', good + '!'], ['oat-newline', key('oat01', 'o') + '\nx']]) {
    assert.equal((await importAccount(`bad-${name}`, text)).status, 400, name);
  }
  assert.equal(repo.findAll().length, before, 'nothing was stored');
});

test('dispatch: a stored api_key credential that is an Admin key or an OAuth token is never sent as x-api-key', async () => {
  for (const kind of ['admin01', 'oat01', 'ort01', 'sid01']) {
    const a = repo.create({name:`stored-${kind}`, provider:'anthropic', credentialType:'api_key', credentials:key(kind, 's')});
    only(a.id);
    upstream(() => { throw new Error('must not dispatch'); });
    const res = await send('/v1/messages', msgBody, claudeHeaders);
    assert.equal(res.status, 400, kind);
    const chat = await send('/v1/chat/completions', JSON.stringify({model:'claude-haiku-5-5', messages:[{role:'user', content:'x'}]}));
    assert.equal(chat.status, 400, kind);
    assert.equal(calls.length, 0, kind);
  }
});

test('chat completions: a personal Claude API key is dispatched too', async () => {
  const personal = key('usr', 'c');
  const a = repo.create({name:'chat-personal', provider:'anthropic', credentialType:'api_key', credentials:personal});
  only(a.id);
  upstream(() => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"synthetic"}}', {status:400, headers:{'content-type':'application/json'}}));
  const res = await send('/v1/chat/completions', JSON.stringify({model:'claude-haiku-5-5', messages:[{role:'user', content:'x'}]}));
  assert.equal(calls.length, 1, res.text);
  assert.equal(calls[0].headers['x-api-key'], personal);
  assert.equal(calls[0].headers.authorization, undefined);
});

test('a Claude key is never accepted for, or sent to, an OpenAI account', async () => {
  const claude = key('usr', 'o');
  const r = await admin('POST', '/admin/accounts/import', {name:'claude-as-openai', provider:'openai', credentials:claude});
  assert.equal(r.status, 400);
  const a = repo.create({name:'stored-claude-as-openai', provider:'openai', credentialType:'api_key', credentials:claude});
  only(a.id);
  upstream(() => { throw new Error('must not dispatch'); });
  assert.equal((await send('/v1/responses', JSON.stringify({model:'gpt-5.5', input:'x'}))).status, 400);
  assert.equal((await send('/v1/chat/completions', JSON.stringify({model:'gpt-5.5', messages:[{role:'user', content:'x'}]}))).status, 400);
  assert.equal(calls.length, 0);
});

test('the Claude API key rule is the same literal in import and both dispatch paths', () => {
  const literal = '/^sk-ant-(?!oat|ort|admin|sid)[A-Za-z0-9_-]+$/';
  for (const file of ['oauth.ts', 'inference.ts', 'passthrough.ts']) {
    const text = readFileSync(new URL(`../src/upstream/${file}`, import.meta.url), 'utf8');
    assert.equal(text.split(literal).length - 1, 1, `${file} carries the rule exactly once`);
    assert.equal((text.match(/\/\^sk-ant-\(\?!/g) ?? []).length, 1, `${file} has no second variant of the rule`);
  }
});

// ADR 0020 addendum: a key that is not scoped to a workspace can never succeed through the router.
const unscoped = {type:'error', error:{type:'invalid_request_error', message:'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.'}, request_id:'req_synthetic'};
const WORKSPACE_NOTICE = '워크스페이스 미지정 API 키: 워크스페이스를 지정한 키로 바꾼 뒤 계정을 다시 켜세요';

test('messages: an API key that is not scoped to a workspace is marked and leaves routing; the 400 is forwarded unchanged', async () => {
  const a = repo.create({name:'unscoped', provider:'anthropic', credentialType:'api_key', credentials:key('usr', 'w')});
  only(a.id);
  upstream(() => json(400, unscoped));
  const res = await send('/v1/messages', msgBody, {...claudeHeaders, 'anthropic-workspace-id':'wrkspc_client_supplied'});
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.text), unscoped);
  assert.equal(calls[0].headers['anthropic-workspace-id'], undefined, 'a client-supplied workspace id is still not forwarded');
  assert.equal(state(a.id).status, 'error');
  assert.equal(state(a.id).lastError, WORKSPACE_NOTICE);
  assert.equal((await admin('GET', '/admin/accounts')).json.accounts.find(x => x.id === a.id).lastError, WORKSPACE_NOTICE, 'the fixed notice is shown to the administrator');
  upstream(() => { throw new Error('must not dispatch'); });
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 503);
  assert.equal(calls.length, 0);
  // Replacing the key and re-enabling in one request brings the account back.
  const scoped = key('usr', 'v');
  assert.equal((await admin('PATCH', `/admin/accounts/${a.id}`, {status:'active', credentials:scoped})).status, 200);
  assert.equal(state(a.id).status, 'active');
  assert.equal(state(a.id).lastError, null);
  upstream(() => sse(claudeFrames));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 200);
  assert.equal(calls[0].headers['x-api-key'], scoped);
});

test('messages: the workspace wording under another status, error type or credential kind does not disable the account', async () => {
  const a = repo.create({name:'not-unscoped', provider:'anthropic', credentialType:'api_key', credentials:key('usr', 'n')});
  only(a.id);
  upstream(() => json(400, {type:'error', error:{type:'api_error', message:unscoped.error.message}}));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
  upstream(() => json(404, unscoped));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 404);
  upstream(() => json(400, {type:'error', error:{type:'invalid_request_error', message:'messages: at least one message is required'}}));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
  // A 400 that quotes client input must not count: a pooled user could otherwise disable the account.
  for (const message of [`messages.0.content.0.type: Input tag '${unscoped.error.message}' found using 'type' does not match any of the expected tags`, unscoped.error.message.toLowerCase(), ' ' + unscoped.error.message,
    'This API key is not scoped to a workspace: Extra inputs are not permitted', `${unscoped.error.message}: Extra inputs are not permitted`, 'This API key is not scoped to a workspace',
    `messages.0.content: ${unscoped.error.message}`, unscoped.error.message + ' ', unscoped.error.message.slice(0, -1)]) {
    upstream(() => json(400, {type:'error', error:{type:'invalid_request_error', message}}));
    assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
    assert.equal(state(a.id).status, 'active', message.slice(0, 40));
  }
  assert.equal(state(a.id).status, 'active');
  const o = anthropicOauth('oauth-workspace');
  only(o.id);
  upstream(() => json(400, unscoped));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 400);
  assert.equal(calls[0].headers.authorization, 'Bearer oat-oauth-workspace', 'the subscription account handled this request');
  assert.equal(state(o.id).status, 'active');
});

test('responses: an OpenAI API-key account is not disabled by the Claude workspace wording', async () => {
  const a = repo.create({name:'openai-workspace-wording', provider:'openai', credentialType:'api_key', credentials:['sk', 'proj', 'q'.repeat(40)].join('-')});
  only(a.id);
  upstream(() => json(400, unscoped));
  assert.equal((await send('/v1/responses', JSON.stringify({model:'gpt-5.5', input:'x'}))).status, 400);
  assert.equal(calls.length, 1);
  assert.equal(state(a.id).status, 'active');
});

test('messages: a streaming request that gets the unscoped-workspace 400 marks the account the same way', async () => {
  const a = repo.create({name:'unscoped-stream', provider:'anthropic', credentialType:'api_key', credentials:key('usr', 'y')});
  only(a.id);
  upstream(() => json(400, unscoped));
  const res = await send('/v1/messages', JSON.stringify({model:'claude-haiku-5-5', max_tokens:5, stream:true, messages:[{role:'user', content:'x'}]}), claudeHeaders);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.text), unscoped);
  assert.equal(state(a.id).lastError, WORKSPACE_NOTICE);
});

test('chat completions: an unscoped-workspace key is not detected on this path (provider body is not read); the account stays active', async () => {
  const a = repo.create({name:'unscoped-chat', provider:'anthropic', credentialType:'api_key', credentials:key('usr', 'z')});
  only(a.id);
  upstream(() => json(400, unscoped));
  const res = await send('/v1/chat/completions', JSON.stringify({model:'claude-haiku-5-5', messages:[{role:'user', content:'x'}]}));
  assert.equal(res.status, 400);
  assert.equal(state(a.id).status, 'active');
});

test('messages: a crafted request whose unknown field name is the provider wording cannot disable the account', async () => {
  const a = repo.create({name:'crafted-field', provider:'anthropic', credentialType:'api_key', credentials:key('usr', 'f')});
  only(a.id);
  // The router forwards unknown top-level fields; a validation 400 then leads with the field name.
  upstream(call => {
    const field = Object.keys(JSON.parse(call.body)).find(k => !['model', 'max_tokens', 'messages'].includes(k));
    return json(400, {type:'error', error:{type:'invalid_request_error', message:`${field}: Extra inputs are not permitted`}});
  });
  const credit = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
  for (const wording of [unscoped.error.message, credit]) {
    const crafted = JSON.stringify({model:'claude-haiku-5-5', max_tokens:5, messages:[{role:'user', content:'x'}], [wording]:1});
    const res = await send('/v1/messages', crafted, claudeHeaders);
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.text).error.message, `${wording}: Extra inputs are not permitted`, 'the synthetic provider echoed the crafted field name first');
    assert.equal(state(a.id).status, 'active');
    assert.equal(state(a.id).lastError, null);
  }
});

// Import refusals name their reason with a fixed code and text, so an administrator can tell a taken
// account name from an unusable credential. The answer never echoes the submitted credential.
const importAs = (provider, name, credentials) => admin('POST', '/admin/accounts/import', {name, provider, credentials});
function assertRefusal(res, status, code, credential, label) {
  assert.equal(res.status, status, label);
  assert.deepEqual(Object.keys(res.json.error).sort(), ['code', 'message'], label);
  assert.equal(res.json.error.code, code, label);
  assert.ok(typeof res.json.error.message === 'string' && res.json.error.message.length > 0, label);
  const body = JSON.stringify(res.json);
  for (const part of [credential.trim(), credential.trim().slice(-12)]) if (part.length >= 8) assert.ok(!body.includes(part), `${label}: the answer must not echo the credential`);
  // The verification checklist tells the user what each answer means; keep its table in step with the texts.
  assert.ok(checklist.includes(`\`${res.status} ${res.json.error.message.split('. ')[0]}`), `${label}: docs/phase5-real-verification.md lists this answer`);
}
const checklist = readFileSync(new URL('../docs/phase5-real-verification.md', import.meta.url), 'utf8');

test('import: a taken account name is refused with 409 account_name_taken and nothing changes', async () => {
  const first = key('usr', 'd'), second = key('usr', 'e');
  const created = await importAs('anthropic', 'dup-name', first);
  assert.equal(created.status, 201);
  const before = repo.findAll().length;
  assertRefusal(await importAs('anthropic', 'dup-name', second), 409, 'account_name_taken', second, 'same provider');
  // Names are unique across providers, and surrounding spaces do not make a new name.
  const openaiCredential = ['sk', 'proj', 'n'.repeat(40)].join('-');
  assertRefusal(await importAs('openai', 'dup-name', openaiCredential), 409, 'account_name_taken', openaiCredential, 'other provider');
  assertRefusal(await importAs('anthropic', '  dup-name ', second), 409, 'account_name_taken', second, 'padded name');
  assert.equal(repo.findAll().length, before, 'nothing was stored');
  only(created.json.account.id);
  upstream(() => sse(claudeFrames));
  assert.equal((await send('/v1/messages', msgBody, claudeHeaders)).status, 200);
  assert.equal(calls[0].headers['x-api-key'], first, 'the existing account keeps its credential');
  // The refused credential itself was fine: it imports under a free name.
  assert.equal((await importAs('anthropic', 'dup-name-2', second)).status, 201);
});

test('import: an unusable credential is refused with 400 and a reason code', async () => {
  const before = repo.findAll().length;
  const usr = key('usr', 'm');
  const cases = [
    ['anthropic', 'not a key at all', 'credential_format_unrecognized'],
    ['anthropic', '   ', 'credential_format_unrecognized'],
    ['anthropic', key('ort01', 'r'), 'credential_format_unrecognized'],
    ['anthropic', key('sid01', 's'), 'credential_format_unrecognized'],
    ['anthropic', usr.slice(0, 20) + '\n' + usr.slice(20), 'credential_format_unrecognized'],
    ['anthropic', '{"claudeAiOauth":{"accessToken":"' + 'j'.repeat(30), 'credential_format_unrecognized'],
    ['anthropic', JSON.stringify({claudeAiOauth:{refreshToken:'k'.repeat(30)}}), 'credential_format_unrecognized'],
    ['anthropic', key('admin01', 'a'), 'admin_key_not_supported'],
    ['openai', usr, 'credential_provider_mismatch'],
    ['openai', 'garbage-' + 'g'.repeat(30), 'credential_format_unrecognized'],
    ['openai', '{"tokens":{"access_token":"' + 'h'.repeat(30), 'credential_format_unrecognized'],
  ];
  for (const [i, [provider, credential, code]] of cases.entries()) {
    assertRefusal(await importAs(provider, `refused-${i}`, credential), 400, code, credential, `${provider} case ${i}`);
  }
  // The credential is checked before the name: a bad credential under a taken name reports the credential.
  assertRefusal(await importAs('anthropic', 'dup-name', key('admin01', 'b')), 400, 'admin_key_not_supported', key('admin01', 'b'), 'bad credential, taken name');
  assert.equal(repo.findAll().length, before, 'nothing was stored');
});

test('import: any other storage failure keeps the generic answer and is not reported as a taken name', async () => {
  const before = repo.findAll().length;
  const generic = res => { assert.equal(res.status, 400); assert.deepEqual(res.json, {error:{message:'Could not import credentials'}}); };
  // A failure that only borrows the wording (not a UNIQUE violation).
  db.exec(`CREATE TEMP TRIGGER import_wording BEFORE INSERT ON main.upstream_accounts WHEN NEW.name = 'trigger-name'
    BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: upstream_accounts.name'); END`);
  try { generic(await importAs('anthropic', 'trigger-name', key('usr', 't'))); }
  finally { db.exec('DROP TRIGGER import_wording'); }
  // A real UNIQUE violation on another column.
  db.exec(`CREATE UNIQUE INDEX import_other_unique ON upstream_accounts(weight) WHERE name LIKE 'idx-%'`);
  try {
    assert.equal((await importAs('anthropic', 'idx-a', key('usr', 'u'))).status, 201);
    generic(await importAs('anthropic', 'idx-b', key('usr', 'v')));
  } finally { db.exec('DROP INDEX import_other_unique'); }
  assert.equal(repo.findAll().length, before + 1, 'only idx-a was stored');
});
