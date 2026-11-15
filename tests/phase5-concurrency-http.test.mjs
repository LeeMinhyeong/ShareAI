// ADR 0021: per-account concurrency limit (upstream_accounts.max_concurrency, 1..16, default 1) and
// immediate release of a slot when the client cancels. Real Express + v1/admin routers over a test-owned
// file SQLite; the provider is a synthetic fetch whose streams the test holds open and releases.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import Database from 'better-sqlite3';

Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(24), LOG_LEVEL:'error', LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const {initDatabase, closeDatabase, getDb, validateOrdinaryProvisioning} = await import('../src/db/client.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
const {captureRawBody, JSON_BODY_LIMIT} = await import('../src/http/raw-body.ts');
const {invokeAccountAttempt, settleAccountAttempt, AccountAttemptOpen} = await import('../src/upstream/account-quota.ts');
const {routingSnapshot} = await import('../src/routes/routing-snapshot.ts');
const {default: v1} = await import('../src/routes/v1.ts');
const {default: admin} = await import('../src/routes/admin.ts');
initDatabase();
const db = getDb();
const repo = new AccountRepository();
new UserRepository().create({apiKeyHash:hashApiKey('cc-key'), name:'cc', email:'cc@example.invalid', tier:'pro', dailyLimit:1000});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', v1);
app.use('/admin', admin);
const server = http.createServer(app);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
assert.notEqual(server.address().port, 20128);
const nativeFetch = globalThis.fetch;
after(async () => { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); });

const event = x => `data: ${JSON.stringify(x)}\n\n`;
const item = (status, content) => ({id:'msg_1', type:'message', status, role:'assistant', content});
const part = text => ({type:'output_text', text, annotations:[]});
const head = [{type:'response.created', response:{id:'resp_1', status:'in_progress'}}, {type:'response.in_progress', response:{id:'resp_1', status:'in_progress'}},
  {type:'response.output_item.added', output_index:0, item:item('in_progress', [])}, {type:'response.content_part.added', item_id:'msg_1', output_index:0, content_index:0, part:part('')},
  {type:'response.output_text.delta', item_id:'msg_1', output_index:0, content_index:0, delta:'hello'}];
const tail = [{type:'response.output_text.done', item_id:'msg_1', output_index:0, content_index:0, text:'hello'},
  {type:'response.content_part.done', item_id:'msg_1', output_index:0, content_index:0, part:part('hello')}, {type:'response.output_item.done', output_index:0, item:item('completed', [part('hello')])},
  {type:'response.completed', response:{id:'resp_1', status:'completed', output:[item('completed', [part('hello')])], usage:{input_tokens:1, output_tokens:1}}}];

const accounts = [];
const disableAll = () => { for (const a of accounts) repo.update(a.id, {status:'disabled'}); };
function account(name, maxConcurrency) {
  const a = repo.create({name, provider:'openai', credentialType:'api_key', credentials:`sk-${name}${'k'.repeat(24)}`, ...(maxConcurrency === undefined ? {} : {maxConcurrency})});
  accounts.push(a); return a;
}
// Every provider stream sends its head, then waits until the test releases it.
let held = [];
function holdingProvider() {
  held = [];
  globalThis.fetch = async (url, init) => {
    let controller;
    const stream = new ReadableStream({start(c) { controller = c; c.enqueue(new TextEncoder().encode(head.map(event).join(''))); }, cancel() { entry.cancelled = true; }});
    const entry = {token:init.headers.authorization, cancelled:false, release() { try { controller.enqueue(new TextEncoder().encode(tail.map(event).join(''))); controller.close(); } catch {} }};
    held.push(entry);
    init.signal?.addEventListener('abort', () => { entry.aborted = true; try { controller.error(init.signal.reason); } catch {} }, {once:true});
    return new Response(stream, {status:200, headers:{'content-type':'text/event-stream'}});
  };
}
const body = JSON.stringify({model:'gpt-5', stream:true, input:[{role:'user', content:'hi'}]});
// Resolves on the first body chunk (the request is in flight) with a handle to finish or abandon it.
function start() {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:server.address().port, path:'/v1/responses', method:'POST', agent:false,
      headers:{authorization:'Bearer cc-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(body)}}, res => {
      const chunks = [];
      const done = new Promise(r => res.on('end', () => r({status:res.statusCode, headers:res.headers, text:Buffer.concat(chunks).toString('utf8')})));
      let first = true;
      res.on('data', c => { chunks.push(c); if (first) { first = false; resolve({status:res.statusCode, headers:res.headers, done, cancel:() => req.destroy()}); } });
      res.on('end', () => { if (first) { first = false; resolve({status:res.statusCode, headers:res.headers, done, cancel:() => {}}); } });
      res.on('error', () => {});
    });
    req.on('error', () => {}); req.end(body);
    setTimeout(() => reject(new Error('no response')), 5000);
  });
}
const openCount = a => db.prepare('SELECT COUNT(*) AS n FROM ordinary_account_attempts WHERE account_id=?').get(a.id).n;
const restriction = a => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(a.id);
async function until(check, label) { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail(label); }
async function finishAll(inflight) { for (const h of held) h.release(); for (const f of inflight) if (f.done) await f.done; }

test('default limit 1: a second concurrent request cannot share the account', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-one');
  assert.equal(repo.findById(a.id).maxConcurrency, 1);
  const first = await start();
  assert.equal(first.status, 200);
  const second = await start();
  assert.equal(second.status, 429, 'the only account is busy');
  assert.equal(held.length, 1, 'one provider call');
  await finishAll([first]);
  await until(() => openCount(a) === 0, 'slot released after completion');
});

test('limit 2: two requests run on the same account at once, a third waits', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-two', 2);
  const r1 = await start(), r2 = await start();
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(held.length, 2, 'both dispatched');
  assert.equal(openCount(a), 2);
  const r3 = await start();
  assert.equal(r3.status, 429);
  assert.equal(r3.headers['retry-after'], '5');
  assert.equal(held.length, 2);
  await finishAll([r1, r2]);
  const t1 = await r1.done, t2 = await r2.done;
  assert.match(t1.text, /response\.completed/); assert.match(t2.text, /response\.completed/);
  await until(() => openCount(a) === 0, 'both slots released');
});

test('a full account is skipped for another account with a free slot', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-full', 1), b = account('cc-free', 2);
  repo.update(b.id, {priority:5});
  const r1 = await start(), r2 = await start(), r3 = await start();
  assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200]);
  assert.equal(openCount(a), 1); assert.equal(openCount(b), 2);
  assert.equal((await start()).status, 429, 'all three slots are in use');
  await finishAll([r1, r2, r3]);
});

test('a client that cancels releases its slot at once and rests nothing', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-cancel', 1);
  const r1 = await start();
  assert.equal(r1.status, 200);
  r1.cancel();
  await until(() => openCount(a) === 0, 'slot released on cancel');
  await until(() => held[0].aborted || held[0].cancelled, 'provider request aborted');
  assert.equal(restriction(a), undefined, 'no account-wide rest after a user cancel (ADR 0021 2Z)');
  const r2 = await start();
  assert.equal(r2.status, 200, 'the account takes the next request immediately');
  await finishAll([r2]);
});

test('with limit 2, one cancel frees one slot while the other request keeps streaming', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-cancel-two', 2);
  const r1 = await start(), r2 = await start();
  r1.cancel();
  await until(() => openCount(a) === 1, 'one slot released');
  const r3 = await start();
  assert.equal(r3.status, 200);
  await finishAll([r2, r3]);
  assert.match((await r2.done).text, /response\.completed/);
});

test('the claim itself enforces the limit under the writer and reads it fresh', async () => {
  disableAll();
  const a = account('cc-claim', 2);
  const signal = new AbortController().signal;
  const handles = [];
  const ok = async () => new Response('');
  for (let i = 0; i < 2; i++) await invokeAccountAttempt(repo.findById(a.id), signal, ok, h => handles.push(h));
  await assert.rejects(invokeAccountAttempt(repo.findById(a.id), signal, ok), AccountAttemptOpen);
  repo.update(a.id, {maxConcurrency:3});
  await invokeAccountAttempt(repo.findById(a.id), signal, ok, h => handles.push(h));
  // A stale account object with the old limit does not raise it; the database value decides.
  const stale = {...repo.findById(a.id), maxConcurrency:16};
  await assert.rejects(invokeAccountAttempt(stale, signal, ok), AccountAttemptOpen);
  for (const h of handles) await settleAccountAttempt(h);
  assert.equal(openCount(a), 0);
});

test('routing snapshot reports an account as open only when it is full', async () => {
  disableAll();
  const a = account('cc-snap', 2);
  const state = () => routingSnapshot().accounts.find(r => r.id === a.id).state;
  assert.equal(state(), 'no_known_block');
  db.prepare('INSERT INTO ordinary_account_attempts(account_id, attempt_id) VALUES (?, ?)').run(a.id, 'snap-1');
  assert.equal(state(), 'no_known_block', 'one of two slots in use');
  db.prepare('INSERT INTO ordinary_account_attempts(account_id, attempt_id) VALUES (?, ?)').run(a.id, 'snap-2');
  assert.equal(state(), 'open');
  db.prepare('DELETE FROM ordinary_account_attempts WHERE account_id=?').run(a.id);
});

function adminCall(method, path, payload) {
  return new Promise((resolve, reject) => {
    const raw = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request({host:'127.0.0.1', port:server.address().port, path, method, agent:false,
      headers:{authorization:`Bearer ${'x'.repeat(24)}`, 'content-type':'application/json', 'content-length':Buffer.byteLength(raw)}}, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({status:res.statusCode, json:text ? JSON.parse(text) : null}); });
    });
    req.on('error', reject); req.end(raw);
  });
}

test('administrators set the limit per account, within 1..16', async () => {
  disableAll();
  const a = account('cc-admin');
  for (const bad of [0, 17, 1.5, '2', -1, null]) {
    const r = await adminCall('PATCH', `/admin/accounts/${a.id}`, {maxConcurrency:bad});
    assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(repo.findById(a.id).maxConcurrency, 1);
  const ok = await adminCall('PATCH', `/admin/accounts/${a.id}`, {maxConcurrency:3});
  assert.equal(ok.status, 200);
  assert.equal(repo.findById(a.id).maxConcurrency, 3);
  const list = await adminCall('GET', '/admin/accounts');
  assert.equal(list.json.accounts.find(x => x.id === a.id).maxConcurrency, 3);
  const created = await adminCall('POST', '/admin/accounts', {name:'cc-admin-new', provider:'openai', credentialType:'api_key', credentials:`sk-ccadminnew${'k'.repeat(24)}`, maxConcurrency:2});
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const made = repo.findAll().find(x => x.name === 'cc-admin-new');
  accounts.push(made);
  assert.equal(made.maxConcurrency, 2);
  assert.equal((await adminCall('POST', '/admin/accounts', {name:'cc-admin-bad', provider:'openai', credentialType:'api_key', credentials:`sk-ccadminbad${'k'.repeat(24)}`, maxConcurrency:20})).status, 400);
});

test('a database from before ADR 0021 is refused with a pointer to a new database', () => {
  const legacy = new Database(':memory:');
  legacy.exec(`CREATE TABLE ordinary_account_attempts (
  account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
);
CREATE TABLE ordinary_attempts_schema_marker (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
);
INSERT INTO ordinary_attempts_schema_marker VALUES (1, 1);`);
  assert.throws(() => validateOrdinaryProvisioning(legacy), /ADR 0021.*db:init/s);
  legacy.close();
});

test('selection itself skips only full accounts, and the wait reflects a full one', async () => {
  disableAll();
  const {accountPool} = await import('../src/account-pool/manager.ts');
  const a = account('cc-select', 2);
  const pick = () => accountPool.selectCandidate('cc-user', 'gpt-5', 'openai', 'priority', {credentialTypes:['oauth', 'api_key']});
  assert.equal((await pick())?.id, a.id);
  db.prepare('INSERT INTO ordinary_account_attempts(account_id, attempt_id) VALUES (?, ?)').run(a.id, 'sel-1');
  assert.equal((await pick())?.id, a.id, 'one free slot left');
  db.prepare('INSERT INTO ordinary_account_attempts(account_id, attempt_id) VALUES (?, ?)').run(a.id, 'sel-2');
  assert.equal(await pick(), null, 'full');
  assert.equal(accountPool.unavailableWaitMs('cc-user', 'openai', {credentialTypes:['oauth', 'api_key']}), 5_000);
  db.prepare('DELETE FROM ordinary_account_attempts WHERE account_id=?').run(a.id);
});

// Review gaps (ADR 0021): provider failures still rest the whole account, other slots are left alone.
test('with limit 2, a provider 429 on one slot rests the account while the other request completes', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-429', 2);
  const r1 = await start();
  assert.equal(r1.status, 200);
  const holding = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({error:{type:'rate_limit_error', message:'slow down'}}), {status:429, headers:{'content-type':'application/json', 'retry-after':'30'}});
  const r2 = await start();
  globalThis.fetch = holding;
  assert.equal(r2.status, 429);
  assert.ok(restriction(a), 'the provider 429 rests the whole account');
  assert.equal(openCount(a), 1, 'only the failed slot was released');
  assert.equal((await start()).status, 429, 'a resting account takes no new request');
  await finishAll([r1]);
  assert.match((await r1.done).text, /response\.completed/, 'the request already in flight completes');
  await until(() => openCount(a) === 0, 'slot released after completion');
});

test('lowering the limit below the requests in flight blocks new ones until enough finish', async () => {
  disableAll(); holdingProvider();
  const a = account('cc-lower', 3);
  for (const id of ['low-1', 'low-2', 'low-3']) db.prepare('INSERT INTO ordinary_account_attempts(account_id, attempt_id) VALUES (?, ?)').run(a.id, id);
  repo.update(a.id, {maxConcurrency:1});
  assert.equal((await start()).status, 429, 'three in flight, limit one');
  db.prepare("DELETE FROM ordinary_account_attempts WHERE attempt_id IN ('low-1','low-2')").run();
  assert.equal((await start()).status, 429, 'one in flight still fills limit one');
  db.prepare("DELETE FROM ordinary_account_attempts WHERE attempt_id='low-3'").run();
  const r = await start();
  assert.equal(r.status, 200);
  await finishAll([r]);
});

test('the limit survives unrelated edits and re-enabling, and the column rejects bad values', async () => {
  disableAll();
  const a = account('cc-keep', 4);
  assert.equal((await adminCall('PATCH', `/admin/accounts/${a.id}`, {priority:3, name:'cc-keep-renamed'})).status, 200);
  assert.equal(repo.findById(a.id).maxConcurrency, 4);
  assert.equal((await adminCall('PATCH', `/admin/accounts/${a.id}`, {status:'disabled'})).status, 200);
  assert.equal((await adminCall('PATCH', `/admin/accounts/${a.id}`, {status:'active'})).status, 200);
  assert.equal(repo.findById(a.id).maxConcurrency, 4, 'reactivation keeps the limit');
  // Integer affinity stores the text '2' as 2, so a non-numeric text stands for the text case.
  for (const bad of [0, 17, 1.5, 'two', null]) assert.throws(() => db.prepare('UPDATE upstream_accounts SET max_concurrency=? WHERE id=?').run(bad, a.id), /constraint/i, `column rejects ${JSON.stringify(bad)}`);
  assert.equal(repo.findById(a.id).maxConcurrency, 4);
  repo.update(a.id, {status:'disabled'});
});

