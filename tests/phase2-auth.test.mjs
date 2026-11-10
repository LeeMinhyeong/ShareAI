import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Never use the caller's database or credentials, even if a local .env exists.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(3);
process.env.LOG_LEVEL = 'error';
process.env.LOG_PRETTY = 'false';

await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const { initDatabase, closeDatabase } = await import('../src/db/client.ts');
const { UserRepository } = await import('../src/db/repositories/users.ts');
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { hashApiKey, generateApiKey } = await import('../src/utils/encryption.ts');
const { authenticateUser, authenticateUserWithoutQuota, authenticateAdmin } = await import('../src/auth/user-auth.ts');
const { logger } = await import('../src/utils/logger.ts');
const { default: adminRouter, routingSnapshotNoStore } = await import('../src/routes/admin.ts');
const db = initDatabase();
after(() => closeDatabase());

function invoke(middleware, headers = {}) {
  const req = { headers };
  const result = { status: 200, passed: false };
  const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
  middleware(req, res, () => { result.passed = true; });
  return { ...result, user: req.user };
}
const bearer = key => ({ authorization: `Bearer ${key}` });
const repo = new UserRepository();
const key = generateApiKey('user');
const user = repo.create({ apiKeyHash: hashApiKey(key), name: 'Test', email: 'auth@example.test', tier: 'free', dailyLimit: 5 });

test('user keys are hashed and both supported headers authenticate the correct user', () => {
  const row = db.prepare('SELECT api_key_hash FROM users WHERE id = ?').get(user.id);
  assert.equal(row.api_key_hash, hashApiKey(key));
  assert.notEqual(row.api_key_hash, key);
  for (const headers of [bearer(key), { 'x-api-key': key }]) {
    const result = invoke(authenticateUser, headers);
    assert.equal(result.passed, true);
    assert.equal(result.user.id, user.id);
    assert.equal(result.user.tier, 'free');
  }
});

test('missing, invalid and disabled user credentials fail closed', () => {
  for (const headers of [{}, bearer('wrong'), { 'x-api-key': 'wrong' }]) {
    const result = invoke(authenticateUser, headers);
    assert.equal(result.status, 401);
    assert.equal(result.passed, false);
  }
  repo.update(user.id, { enabled: false });
  try { assert.equal(invoke(authenticateUser, bearer(key)).status, 401); }
  finally { repo.update(user.id, { enabled: true }); }
  assert.equal(invoke(authenticateUser, bearer(key)).passed, true);
});

test('daily limit rejects an authenticated user at the boundary', () => {
  repo.update(user.id, { dailyLimit: 0 });
  try {
    const result = invoke(authenticateUser, bearer(key));
    assert.equal(result.status, 429);
    assert.equal(result.passed, false);
  } finally { repo.update(user.id, { dailyLimit: 5 }); }
});

test('completion logs do not double-count an accepted reservation', () => {
  const key2 = generateApiKey('user');
  const user2 = repo.create({ apiKeyHash: hashApiKey(key2), name: 'Quota', email: 'quota-auth@example.test', tier: 'free', dailyLimit: 2 });
  const account = new AccountRepository().create({ name: 'Test', provider: 'openai', credentialType: 'api_key', credentials: 'fixture' });
  // Unknown provider usage is stored as NULL tokens with usage_known=0, as UsageLogRepository writes it.
  const insert = db.prepare('INSERT INTO usage_logs (id, user_id, upstream_account_id, timestamp, model, provider, input_tokens, output_tokens, usage_known, success, latency_ms) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)');
  assert.equal(invoke(authenticateUser, bearer(key2)).passed, true);
  insert.run('successful', user2.id, account.id, new Date().toISOString(), 'test', 'openai', 1, 1);
  assert.equal(invoke(authenticateUser, bearer(key2)).passed, true);
  assert.equal(invoke(authenticateUser, bearer(key2)).status, 429);
});

test('admin credentials are distinct and required', () => {
  assert.equal(invoke(authenticateAdmin).status, 401);
  assert.equal(invoke(authenticateAdmin, { 'x-api-key': process.env.ADMIN_API_KEY }).status, 401);
  assert.equal(invoke(authenticateAdmin, bearer(key)).status, 403);
  assert.equal(invoke(authenticateAdmin, bearer(process.env.ADMIN_API_KEY)).passed, true);
  assert.equal(invoke(authenticateUser, bearer(process.env.ADMIN_API_KEY)).status, 401);
});

test('invalid user key does not log key material or its hash', () => {
  const original = logger.warn;
  const entries = [];
  logger.warn = (...args) => entries.push(args);
  try { assert.equal(invoke(authenticateUser, bearer('invalid-test-key')).status, 401); }
  finally { logger.warn = original; }
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes('invalid-test-key'), false);
  assert.equal(serialized.includes(hashApiKey('invalid-test-key').slice(0, 16)), false);
});

test('all direct administrator routes authenticate before handlers', () => {
  const routes = adminRouter.stack.filter(layer => layer.route).map(layer => layer.route);
  assert.ok(routes.length > 0);
  for (const route of routes) {
    const snapshot = route.path === '/routing-snapshot' && route.methods.get;
    if (snapshot) assert.equal(route.stack[0].handle, routingSnapshotNoStore);
    assert.equal(route.stack[snapshot ? 1 : 0].handle, authenticateAdmin, `unguarded route ${route.path}`);
  }
  // The former v1 identity assertion is not yet replaced by equivalent coverage.
  // The all-route synthetic test is incomplete and its mutation case can hang.
});
