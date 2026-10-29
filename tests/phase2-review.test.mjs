import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(3);
process.env.LOG_LEVEL = 'error';
process.env.LOG_PRETTY = 'false';
const { initDatabase, closeDatabase } = await import('../src/db/client.ts');
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { UserRepository } = await import('../src/db/repositories/users.ts');
const { UsageLogRepository } = await import('../src/db/repositories/usage-logs.ts');
const { default: router } = await import('../src/routes/admin.ts');
const { authenticateUser } = await import('../src/auth/user-auth.ts');
const { hashApiKey } = await import('../src/utils/encryption.ts');
const { accountPool } = await import('../src/account-pool/manager.ts');
const { forwardChat } = await import('../src/upstream/forward-chat.ts');
const db = initDatabase();
const accounts = new AccountRepository(), users = new UserRepository(), logs = new UsageLogRepository();
after(() => closeDatabase());
function invoke(method, path, body = {}, id) {
  const route = router.stack.find(l => l.route?.path === path && l.route.methods[method]).route;
  const req = { headers: { authorization: `Bearer ${process.env.ADMIN_API_KEY}` }, params: { id }, body };
  const result = { status: 200, headers: {} };
  const res = { set(k,v) { result.headers[k.toLowerCase()] = v; return this; }, status(v) { result.status = v; return this; }, json(v) { result.body = v; return this; }, end() { return this; } };
  let i = 0; const next = () => route.stack[i++].handle(req,res,next); next(); return result;
}
test('corrupt ciphertext and unmarked plaintext are never returned as credentials', () => {
  const account = accounts.create({name:'bad', provider:'openai', credentialType:'api_key', credentials:'original'});
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 0xbb), Buffer.alloc(16));
  const encrypted = cipher.update('secret','utf8','hex') + cipher.final('hex');
  const wrongKeyCiphertext = '0'.repeat(32) + ':' + cipher.getAuthTag().toString('hex') + ':' + encrypted;
  for (const value of ['plaintext-unmarked', '0'.repeat(32)+':'+ '0'.repeat(32)+':aa', wrongKeyCiphertext]) {
    db.prepare('UPDATE upstream_accounts SET credentials = ? WHERE id = ?').run(value, account.id);
    assert.throws(() => accounts.findById(account.id));
    assert.equal(db.prepare('SELECT credentials FROM upstream_accounts WHERE id = ?').get(account.id).credentials, value);
  }
});
test('deletion refuses to destroy usage history and daily limit evidence', () => {
  const u = users.create({apiKeyHash:'hash',name:'test',email:'test@test.invalid',tier:'free',dailyLimit:1});
  const a = accounts.create({name:'used',provider:'openai',credentialType:'api_key',credentials:'key'});
  assert.equal(users.reserveDailyQuota('hash').allowed,true);
  const l = logs.create({userId:u.id,upstreamAccountId:a.id,model:'m',provider:'openai',inputTokens:0,outputTokens:0,success:true,latencyMs:1});
  assert.equal(invoke('delete','/accounts/:id',{},a.id).status,409);
  assert.throws(() => db.prepare('DELETE FROM upstream_accounts WHERE id = ?').run(a.id), /account has usage history/);
  assert.ok(logs.findById(l.id)); assert.ok(accounts.findById(a.id)); assert.equal(users.getTodayUsageCount(u.id),1);
});
test('admin validates dailyLimit and enabled on create and patch', () => {
  for (const value of [-1,1.5,'10',null,Number.MAX_SAFE_INTEGER+1]) assert.equal(invoke('post','/users',{name:'x',email:'x@test.invalid',dailyLimit:value}).status,400);
  assert.equal(invoke('post','/users',{name:'enabled-invalid',email:'enabled-invalid@test.invalid',enabled:'false'}).status,400);
  const created = invoke('post','/users',{name:'valid',email:'valid@test.invalid',dailyLimit:1});
  assert.equal(created.status,201);
  for (const value of [-1,1.5,'10',null,Number.MAX_SAFE_INTEGER+1]) assert.equal(invoke('patch','/users/:id',{dailyLimit:value},created.body.user.id).status,400);
  for (const value of ['false',0,null]) assert.equal(invoke('patch','/users/:id',{enabled:value},created.body.user.id).status,400);
  assert.equal(users.findById(created.body.user.id).dailyLimit,1);
});
test('new user key response is not cacheable', () => {
  const result = invoke('post','/users',{name:'cache',email:'cache@test.invalid'});
  assert.equal(result.status,201); assert.equal(result.headers['cache-control'],'no-store');
});

test('authentication reserves the last available quota slot once', () => {
  const key = 'race-key';
  const u = users.create({apiKeyHash:hashApiKey(key),name:'race',email:'race@test.invalid',tier:'free',dailyLimit:1});
  const call = () => {
    let passed = false;
    authenticateUser({headers:{authorization:`Bearer ${key}`}}, {status(){return this},json(){return this}}, () => {passed = true});
    return passed;
  };
  assert.equal(users.getTodayUsageCount(u.id),0);
  assert.equal(call(),true); assert.equal(call(),false);
});

test('successful completion without usage retains the reservation', async () => {
  const u = users.create({apiKeyHash:'no-usage-hash',name:'no-usage',email:'no-usage@test.invalid',tier:'free',dailyLimit:1});
  const a = accounts.create({name:'no-usage',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'key',accountId:'workspace'})});
  const select = accountPool.selectAccount, fetch = globalThis.fetch;
  accountPool.selectAccount = async () => a;
  globalThis.fetch = async () => new Response('data: {"type":"response.completed","response":{"id":"r"}}\n\n',{headers:{'content-type':'text/event-stream'}});
  const res = new EventEmitter(); res.json = body => {res.body = body}; res.status = code => {res.statusCode = code; return res};
  try {
    assert.equal(users.reserveDailyQuota(u.apiKeyHash).allowed,true);
    await forwardChat({user:u,body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}},res);
    assert.ok(res.body.choices); assert.equal(users.getTodayUsageCount(u.id),1);
  } finally {accountPool.selectAccount = select; globalThis.fetch = fetch;}
});

test('usage log write failure does not erase an existing reservation', async () => {
  const u = users.create({apiKeyHash:'failure-hash',name:'failure',email:'failure@test.invalid',tier:'free',dailyLimit:1});
  const a = accounts.create({name:'failure',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'key',accountId:'workspace'})});
  const select = accountPool.selectAccount, fetch = globalThis.fetch;
  accountPool.selectAccount = async () => a;
  globalThis.fetch = async () => new Response('data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',{headers:{'content-type':'text/event-stream'}});
  db.exec("CREATE TEMP TRIGGER fail_usage BEFORE INSERT ON usage_logs BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const res = new EventEmitter(); res.json = body => {res.body = body}; res.status = code => {res.statusCode = code; return res};
  try {
    assert.equal(users.reserveDailyQuota(u.apiKeyHash).allowed,true);
    await forwardChat({user:u,body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}},res);
    assert.ok(res.body.choices); assert.equal(users.getTodayUsageCount(u.id),1);
  } finally {db.exec('DROP TRIGGER fail_usage'); accountPool.selectAccount = select; globalThis.fetch = fetch;}
});
