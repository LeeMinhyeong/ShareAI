// ADR 0019 item 8: when no upstream account can serve a request, the router tells the client
// whether waiting can help. A short, known wait is a 429 with Retry-After (clients retry it);
// anything an administrator must fix, or a wait over five minutes, is a 403 that clients show.
// Real Express + v1 router (auth, quota, tracking) over a test-owned file SQLite; no provider is called.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';

Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(24), LOG_LEVEL:'error', LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const {initDatabase, closeDatabase, getDb} = await import('../src/db/client.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {AccountRepository, refreshFingerprint} = await import('../src/db/repositories/accounts.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
const {captureRawBody, JSON_BODY_LIMIT} = await import('../src/http/raw-body.ts');
const {arm429V2} = await import('../src/db/account-429-v2-store.ts');
const {default: router} = await import('../src/routes/v1.ts');
initDatabase();
const db = getDb();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('na-key'), name:'na', email:'na@example.invalid', tier:'pro', dailyLimit:1000});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', router);
const server = http.createServer(app);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
assert.notEqual(server.address().port, 20128);
const nativeFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('no provider call is expected'); };
after(async () => { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); });

const RETRY_MESSAGE = 'All upstream accounts for this request are busy or resting. Retry shortly.';
const ADMIN_MESSAGE = 'No upstream account can serve this request now. Contact the administrator.';
const accounts = [];
const disableAll = () => { for (const a of accounts) repo.update(a.id, {status:'disabled'}); };
function account(name, provider = 'anthropic') {
  const credentials = provider === 'anthropic' ? JSON.stringify({kind:'oauth', accessToken:`oat-${name}`, refreshToken:`ort-${name}`, expiresAt:Date.now() + 3600_000}) : `sk-${name}`;
  const a = repo.create({name, provider, credentialType:provider === 'anthropic' ? 'oauth' : 'api_key', credentials});
  accounts.push(a); return a;
}
const rest = (a, ms) => db.transaction(() => arm429V2(db, 'upstream', a.id, ms)).immediate();
const busy = a => db.prepare('INSERT INTO ordinary_account_attempts(account_id, attempt_id) VALUES (?, ?)').run(a.id, `held-${a.id}`);
const claudeBody = JSON.stringify({model:'claude-opus-5-5', max_tokens:64, stream:true, messages:[{role:'user', content:'hi'}]});
const codexBody = JSON.stringify({model:'gpt-6.1-terra', stream:true, input:[{role:'user', content:'hi'}]});
const chatBody = JSON.stringify({model:'gpt-5', messages:[{role:'user', content:'hi'}]});
function send(path, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method:'POST', agent:false,
      headers:{authorization:'Bearer na-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(rawBody)}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject); req.end(rawBody);
  });
}
const claude = () => send('/v1/messages', claudeBody);
async function expectAdmin(r, label) {
  assert.equal(r.status, 403, `${label}: ${r.text}`);
  assert.equal(r.headers['retry-after'], undefined, `${label}: nothing to wait for`);
  assert.equal(calls, 0, `${label}: no provider call`);
  return JSON.parse(r.text);
}
async function expectRetry(r, seconds, label) {
  assert.equal(r.status, 429, `${label}: ${r.text}`);
  assert.equal(r.headers['retry-after'], String(seconds), label);
  assert.equal(calls, 0, `${label}: no provider call`);
  return JSON.parse(r.text);
}

test('no account at all: 403 in each client protocol, with a fixed message and no account details', async () => {
  disableAll();
  const m = await expectAdmin(await claude(), 'messages');
  assert.deepEqual(m, {type:'error', error:{type:'permission_error', message:ADMIN_MESSAGE}});
  const r = await expectAdmin(await send('/v1/responses', codexBody), 'responses');
  assert.equal(r.error.type, 'permission_error');
  assert.equal(r.error.message, ADMIN_MESSAGE);
  const c = await expectAdmin(await send('/v1/chat/completions', chatBody), 'chat completions');
  assert.equal(c.error.message, ADMIN_MESSAGE);
});

test('accounts that are disabled or marked error need an administrator: 403', async () => {
  disableAll();
  const off = account('na-off'); repo.update(off.id, {status:'disabled'});
  const broken = account('na-error'); repo.update(broken.id, {status:'error', lastError:'API 크레딧 소진(credit_balance_too_low): 크레딧을 충전한 뒤 계정을 다시 켜세요'});
  const body = await expectAdmin(await claude(), 'disabled and error');
  assert.ok(!JSON.stringify(body).includes('na-'), 'no account names reach the client');
});

test('an account resting after an abort or a provider failure: 429 with the rest as Retry-After', async () => {
  disableAll();
  rest(account('na-rest'), 60_000);
  const body = await expectRetry(await claude(), 60, 'resting');
  assert.deepEqual(body, {type:'error', error:{type:'rate_limit_error', message:RETRY_MESSAGE}});
});

test('an account busy with another request: 429 with a short Retry-After', async () => {
  disableAll();
  busy(account('na-busy'));
  await expectRetry(await claude(), 5, 'busy');
  const r = JSON.parse((await send('/v1/responses', codexBody)).text);
  assert.equal(r.error.message, ADMIN_MESSAGE, 'another provider with no account still needs an administrator');
});

test('waits that no client should sit through: indefinite or longer than five minutes is a 403', async () => {
  disableAll();
  rest(account('na-indefinite'), null);
  await expectAdmin(await claude(), 'indefinite restriction');
  disableAll();
  rest(account('na-long'), 600_000);
  await expectAdmin(await claude(), 'ten-minute restriction');
  disableAll();
  rest(account('na-edge'), 300_000);
  await expectRetry(await claude(), 300, 'exactly five minutes');
});

test('a zero-length restriction row still hides the account, as any row did before', async () => {
  disableAll();
  const a = account('na-zero-rest');
  rest(a, 0);
  const {accountPool} = await import('../src/account-pool/manager.ts');
  assert.equal(await accountPool.selectCandidate('na-user', 'claude-opus-5-5', 'anthropic', 'priority', {credentialTypes:['oauth', 'api_key']}), null, 'not selected');
  await expectRetry(await claude(), 5, 'zero duration');
});

test('the shortest wait among the accounts decides', async () => {
  disableAll();
  rest(account('na-mix-indefinite'), null);
  rest(account('na-mix-long'), 120_000);
  busy(account('na-mix-busy'));
  const off = account('na-mix-off'); repo.update(off.id, {status:'disabled'});
  await expectRetry(await claude(), 5, 'mixed');
  // An account resting and busy at once is free only when both clear.
  disableAll();
  const both = account('na-both'); rest(both, 90_000); busy(both);
  await expectRetry(await claude(), 90, 'resting and busy');
});

test('an account the request can never use does not count as a wait', async () => {
  disableAll();
  // Codex subscription accounts cannot take temperature/max_tokens on chat completions.
  const sub = repo.create({name:'na-codex-sub', provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:'cat-na', refreshToken:'crt-na', accountId:'ws-na', expiresAt:Date.now() + 3600_000})});
  accounts.push(sub);
  const c = await expectAdmin(await send('/v1/chat/completions', JSON.stringify({model:'gpt-5', temperature:0.2, messages:[{role:'user', content:'hi'}]})), 'generation options');
  assert.equal(c.error.message, ADMIN_MESSAGE);
});

test('a Codex account whose token refresh is in flight is skipped and counted as busy', async () => {
  disableAll();
  const sub = repo.create({name:'na-refreshing', provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:'cat-rf', refreshToken:'crt-rf', accountId:'ws-rf', expiresAt:Date.now() + 3600_000})});
  accounts.push(sub);
  db.prepare('INSERT INTO oauth_refresh_intents(token_fingerprint, attempt_id, account_id, created_at) VALUES (?, ?, ?, ?)').run(refreshFingerprint('openai', 'crt-rf'), 'held-refresh', sub.id, new Date().toISOString());
  await expectRetry(await send('/v1/responses', codexBody), 5, 'refresh in flight');
});

test('if explaining the outcome fails, the old 503 is kept', async () => {
  disableAll();
  const {accountPool} = await import('../src/account-pool/manager.ts');
  const original = accountPool.unavailableWaitMs;
  accountPool.unavailableWaitMs = () => { throw new Error('synthetic classification failure'); };
  try {
    const r = await claude();
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).error.message, 'No supported upstream account available');
    assert.equal(calls, 0);
  } finally { accountPool.unavailableWaitMs = original; }
});

const today = () => new Date().toISOString().slice(0, 10);
const reserve = (a, day, used, legacy = 0) => db.prepare('INSERT OR REPLACE INTO account_daily_reservations(account_id, day, used, legacy_ambiguous) VALUES (?, ?, ?, ?)').run(a.id, day, used, legacy);
const exceeded = (a, resetAt) => db.prepare("UPDATE upstream_accounts SET status='quota_exceeded', quota_info=? WHERE id=?").run(JSON.stringify({resetAt}), a.id);
const untilUtcMidnight = () => Math.ceil((Date.parse(`${today()}T00:00:00Z`) + 86_400_000 - Date.now()) / 1000);

test('a damaged daily-quota row needs an administrator: 403, never a short wait', async () => {
  disableAll();
  const future = account('na-quota-future'); reserve(future, '2999-01-01', 0);
  await expectAdmin(await claude(), 'reservation dated in the future');
});

test('a daily quota used up, or ambiguous from a legacy migration, waits for the UTC day to change', async () => {
  for (const [label, arrange] of [['used up', a => reserve(a, today(), 3)], ['legacy ambiguous', a => reserve(a, today(), 0, 1)]]) {
    disableAll();
    const a = account(`na-day-${label.replace(' ', '-')}`); repo.update(a.id, {dailyQuota:3}); arrange(a);
    const r = await claude();
    if (untilUtcMidnight() > 300) await expectAdmin(r, label);
    else assert.equal(r.status, 429, label);
  }
});

test('quota_exceeded with a reset time: a near reset is a 429 with the wait, a far one a 403', async () => {
  disableAll();
  const near = account('na-reset-near');
  exceeded(near, Date.now() + 120_000);
  const r = await claude();
  assert.equal(r.status, 429, r.text);
  assert.ok([120, 121].includes(Number(r.headers['retry-after'])), r.headers['retry-after']);
  disableAll();
  const far = account('na-reset-far');
  exceeded(far, Date.now() + 3_600_000);
  await expectAdmin(await claude(), 'reset in an hour');
});

test('the Responses and Chat Completions envelopes carry the retry message too', async () => {
  disableAll();
  const key = account('na-openai-busy', 'openai'); rest(key, 30_000);
  const r = await expectRetry(await send('/v1/responses', codexBody), 30, 'responses');
  assert.equal(r.error.message, RETRY_MESSAGE);
  const c = await expectRetry(await send('/v1/chat/completions', chatBody), 30, 'chat completions');
  assert.equal(c.error.message, RETRY_MESSAGE);
});

test('selection itself skips busy, excluded and backing-off accounts, and the wait matches each', async () => {
  const {accountPool} = await import('../src/account-pool/manager.ts');
  const pick = (o = {}) => accountPool.selectCandidate('na-user', 'claude-opus-5-5', 'anthropic', 'priority', {credentialTypes:['oauth', 'api_key'], ...o});
  disableAll();
  const held = account('na-sel-busy'); busy(held);
  assert.equal(await pick(), null, 'an account with an OPEN attempt is not selected');
  disableAll();
  const lost = account('na-sel-excluded');
  assert.equal(await pick({excludeUpstream:new Set([lost.id])}), null);
  assert.equal(accountPool.unavailableWaitMs('na-user', 'anthropic', {credentialTypes:['oauth', 'api_key'], excludeUpstream:new Set([lost.id])}), 5_000);
  disableAll();
  const failing = account('na-sel-backoff');
  for (let i = 0; i < 3; i++) accountPool.recordFailure(failing.id, {status:500, message:'synthetic'});
  assert.equal(await pick(), null, 'an account backing off after failures is not selected');
  const r = await claude();
  assert.equal(r.status, 429, r.text);
  assert.ok([20, 21].includes(Number(r.headers['retry-after'])), `third failure backs off 20-21s, got ${r.headers['retry-after']}`);
});

