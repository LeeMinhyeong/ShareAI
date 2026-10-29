import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(3);
process.env.LOG_LEVEL = 'error';
process.env.LOG_PRETTY = 'false';

const { initDatabase, closeDatabase, getDb } = await import('../src/db/client.ts');
const { UserRepository } = await import('../src/db/repositories/users.ts');
const { hashApiKey } = await import('../src/utils/encryption.ts');
const { authenticateUser } = await import('../src/auth/user-auth.ts');
initDatabase();
after(() => closeDatabase());

test('a second in-flight request cannot take the last daily slot', () => {
  const key = 'quota-atomicity-test-key';
  new UserRepository().create({apiKeyHash: hashApiKey(key), name: 'quota', email: 'quota@test.invalid', tier: 'free', dailyLimit: 1});
  function authorize() {
    let passed = false, status = 200;
    authenticateUser({headers: {'x-api-key': key}}, {status(code) {status = code; return this}, json() {return this}}, () => {passed = true});
    return {passed, status};
  }
  assert.deepEqual(authorize(), {passed: true, status: 200});
  assert.deepEqual(authorize(), {passed: false, status: 429});
});

test('write failure denies before next', () => {
  const key='quota-write-failure'; const repo=new UserRepository();
  repo.create({apiKeyHash:hashApiKey(key),name:'write',email:'write@test.invalid',tier:'free',dailyLimit:1});
  getDb().exec("CREATE TRIGGER quota_write_failure BEFORE INSERT ON user_daily_quota BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
  let status=200, passed=false;
  try { authenticateUser({headers:{'x-api-key':key}}, {status(n){status=n;return this},json(){return this}},()=>{passed=true}); }
  finally { getDb().exec('DROP TRIGGER quota_write_failure'); }
  assert.equal(status,503); assert.equal(passed,false);
  assert.equal(repo.reserveDailyQuota(hashApiKey(key)).allowed,true);
});

test('UTC midnight, zero limit, disabled and deleted users', () => {
  const repo=new UserRepository(), key='utc-key', hash=hashApiKey(key);
  const user=repo.create({apiKeyHash:hash,name:'utc',email:'utc@test.invalid',tier:'free',dailyLimit:1});
  assert.equal(repo.reserveDailyQuota(hash,new Date('2030-01-01T23:59:59.999Z')).allowed,true);
  assert.equal(repo.reserveDailyQuota(hash,new Date('2030-01-01T23:59:59.999Z')).allowed,false);
  assert.equal(repo.reserveDailyQuota(hash,new Date('2030-01-02T00:00:00.000Z')).allowed,true);
  repo.update(user.id,{enabled:false}); assert.equal(repo.reserveDailyQuota(hash).user,null);
  assert.throws(()=>getDb().prepare('DELETE FROM users WHERE id=?').run(user.id),/usage history/);
  repo.update(user.id,{enabled:true,dailyLimit:0}); assert.equal(repo.reserveDailyQuota(hash).allowed,false);
  const other=repo.create({apiKeyHash:hashApiKey('deleted'),name:'deleted',email:'deleted@test.invalid',tier:'free',dailyLimit:1});
  getDb().prepare('DELETE FROM users WHERE id=?').run(other.id);
  assert.equal(repo.reserveDailyQuota(hashApiKey('deleted')).user,null);
});
