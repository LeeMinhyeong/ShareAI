import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

const scratch = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch') : (process.env.TMPDIR || os.tmpdir());
const dir = mkdtempSync(path.join(scratch, 'phase2-repository-'));
process.env.TMPDIR = dir;
const file = path.join(dir, 'test.sqlite');
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `sqlite:${file}`, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' });
const { initDatabase, closeDatabase } = await import('../src/db/client.ts');
const { UserRepository } = await import('../src/db/repositories/users.ts');
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { UsageLogRepository } = await import('../src/db/repositories/usage-logs.ts');
const db = initDatabase();
const users = new UserRepository(), accounts = new AccountRepository(), logs = new UsageLogRepository();
after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

const newUser = (name) => users.create({ apiKeyHash: `hash-${name}`, name, email: `${name}@test.invalid`, tier: 'free', dailyLimit: 10 });
const newAccount = (name) => accounts.create({ name, provider: 'openai', credentialType: 'api_key', credentials: `secret-${name}` });
const newLog = (userId, upstreamAccountId, success = true) => logs.create({ userId, upstreamAccountId, model: 'test', provider: 'openai', inputTokens: 2, outputTokens: 3, success, latencyMs: 4 });

test('user and account CRUD respect defaults, update errors, and missing records', () => {
  const u = newUser('crud');
  const other = newUser('other');
  const a = newAccount('crud-account');
  assert.equal(users.findByApiKeyHash(u.apiKeyHash).id, u.id);
  assert.equal(users.findById('missing'), null);
  assert.equal(accounts.findById('missing'), null);
  assert.equal(a.status, 'active');
  assert.equal(a.dailyQuota, 0);
  assert.equal(a.weight, 1);
  assert.equal(a.credentials, 'secret-crud-account');
  assert.notEqual(db.prepare('SELECT credentials FROM upstream_accounts WHERE id = ?').get(a.id).credentials, a.credentials);
  users.update(u.id, { enabled: false, dailyLimit: 0 });
  assert.equal(users.findByApiKeyHash(u.apiKeyHash), null);
  assert.equal(users.findById(u.id).dailyLimit, 0);
  assert.throws(() => users.update(u.id, { name: 'should-rollback', email: other.email }), /UNIQUE/);
  assert.equal(users.findById(u.id).name, 'crud');
  accounts.update(a.id, { name: 'renamed', priority: 3, weight: 2, credentials: '' });
  assert.equal(accounts.findById(a.id).credentials, a.credentials);
  assert.equal(accounts.findById(a.id).priority, 3);
  assert.throws(() => accounts.update(a.id, { name: 'invalid-rollback', status: 'invalid' }), /CHECK/);
  assert.equal(accounts.findById(a.id).name, 'renamed');
  assert.ok(accounts.findAll().some(item => item.id === a.id));
  assert.ok(users.findAll().some(item => item.id === u.id));
});

test('usage logs enforce FK, filter, aggregate, and protect history', () => {
  const u1 = newUser('usage-one'), u2 = newUser('usage-two');
  const a1 = newAccount('usage-one'), a2 = newAccount('usage-two');
  const l1 = newLog(u1.id, a1.id), l2 = newLog(u1.id, a2.id, false), l3 = newLog(u2.id, a2.id);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.throws(() => newLog('absent', a1.id), /FOREIGN KEY/);
  assert.throws(() => newLog(u1.id, 'absent'), /FOREIGN KEY/);
  assert.equal(logs.findById('absent'), null);
  assert.equal(logs.findByUser(u1.id, 1).length, 1);
  assert.equal(logs.findByAccount(a2.id).length, 2);
  assert.deepEqual(logs.getTodayStats(u1.id), { totalRequests: 2, successRequests: 1, totalTokens: 10 });
  assert.deepEqual(logs.getAccountTodayStats(a2.id), { totalRequests: 2, successRequests: 1, totalTokens: 10 });
  assert.equal(users.getTodayUsageCount(u1.id), 0);
  assert.throws(() => accounts.delete(a1.id), /usage history/);
  assert.equal(logs.findById(l1.id).id, l1.id);
  assert.equal(logs.findById(l2.id).id, l2.id);
  assert.equal(logs.findById(l3.id).id, l3.id);
  assert.throws(() => db.prepare('DELETE FROM users WHERE id = ?').run(u1.id), /usage history/);
  assert.equal(logs.findById(l2.id).id, l2.id);
  assert.equal(logs.findById(l3.id).id, l3.id);
  assert.ok(accounts.findById(a2.id));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('admin account endpoint contracts hide secrets and report missing records', async () => {
  const { default: router } = await import('../src/routes/admin.ts');
  function invoke(method, routePath, { id, body = {}, authenticated = true } = {}) {
    const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]).route;
    const req = { headers: authenticated ? { authorization: `Bearer ${process.env.ADMIN_API_KEY}` } : {}, params: { id }, body };
    const result = { status: 200 };
    const res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; }, end() { return this; } };
    let index = 0;
    const next = () => route.stack[index++].handle(req, res, next);
    next();
    return result;
  }
  assert.equal(invoke('get', '/accounts', { authenticated: false }).status, 401);
  assert.equal(invoke('get', '/accounts/:id', { id: 'absent' }).status, 404);
  assert.equal(invoke('post', '/accounts', { body: {} }).status, 400);
  const created = invoke('post', '/accounts', { body: { name: 'api-contract', provider: 'openai', credentialType: 'api_key', credentials: 'fixture-api-secret' } });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes('fixture-api-secret'), false);
  const id = created.body.account.id;
  const conflict = invoke('patch', '/accounts/:id', { id, body: { name: 'renamed', priority: 99 } });
  assert.equal(conflict.status, 500);
  assert.equal(accounts.findById(id).name, 'api-contract');
  assert.equal(accounts.findById(id).priority, 0);
  const detail = invoke('get', '/accounts/:id', { id });
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(detail.body).includes('fixture-api-secret'), false);
  const update = invoke('patch', '/accounts/:id', { id, body: { name: 'api-renamed' } });
  assert.equal(update.status, 200);
  assert.equal(update.body.account.name, 'api-renamed');
  assert.equal(invoke('delete', '/accounts/:id', { id }).status, 204);
  assert.equal(invoke('delete', '/accounts/:id', { id }).status, 404);
});

test('legacy rebuild preserves users, logs and revision values across repeated migrations', () => {
  const legacy = path.join(dir, 'legacy.sqlite');
  const old = new Database(legacy);
  old.exec(SQL_SCHEMA.replace(", 'oauth'", '').replace('  meta TEXT,\n', '').replace('  quota_info TEXT,\n', ''));
  old.exec("INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','hash','legacy','legacy@test.invalid','free'); INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at,state_revision,credential_revision,last_refresh_revision) VALUES('a','legacy','openai','api_key','legacy-secret','active','2099-01-01',7,8,6); INSERT INTO usage_logs(id,user_id,upstream_account_id,model,provider,success,latency_ms) VALUES('l','u','a','m','openai',1,4)");
  old.close();
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATABASE_URL: `sqlite:${legacy}` } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const migrated = new Database(legacy);
  try {
    assert.deepEqual(migrated.prepare('SELECT credentials,state_revision,credential_revision,last_refresh_revision,meta,quota_info FROM upstream_accounts WHERE id = ?').get('a'), { credentials: 'legacy-secret', state_revision: 7, credential_revision: 8, last_refresh_revision: 6, meta: null, quota_info: null });
    assert.equal(migrated.prepare('SELECT count(*) n FROM usage_logs WHERE id = ? AND user_id = ? AND upstream_account_id = ?').get('l', 'u', 'a').n, 1);
    assert.deepEqual(migrated.pragma('foreign_key_check'), []);
    assert.equal(migrated.pragma('integrity_check', { simple: true }), 'ok');
    migrated.pragma('foreign_keys = ON');
    assert.throws(() => migrated.prepare('DELETE FROM upstream_accounts WHERE id = ?').run('a'), /usage history/);
    assert.equal(migrated.prepare('SELECT count(*) n FROM usage_logs').get().n, 1);
    assert.equal(migrated.prepare('SELECT count(*) n FROM users').get().n, 1);
  } finally { migrated.close(); }
});
