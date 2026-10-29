import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'test-admin-key-'.repeat(3), LOG_LEVEL: 'error', LOG_PRETTY: 'false' });
const { initDatabase, closeDatabase } = await import('../src/db/client.ts');
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { UserRepository } = await import('../src/db/repositories/users.ts');
const { UsageLogRepository } = await import('../src/db/repositories/usage-logs.ts');
const { default: router } = await import('../src/routes/admin.ts');
const db = initDatabase(), accounts = new AccountRepository();
after(() => closeDatabase());
function invoke(method, routePath, { id, body = {}, auth = true } = {}) {
  const route = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]).route;
  const req = { headers: auth ? { authorization: `Bearer ${process.env.ADMIN_API_KEY}` } : {}, params: { id }, body };
  const result = { status: 200 };
  const res = { set() { return this; }, status(v) { result.status = v; return this; }, json(v) { result.body = v; return this; }, end() { return this; } };
  let i = 0; const next = () => route.stack[i++].handle(req, res, next); next(); return result;
}
const create = (name, provider = 'openai', credentials = 'valid-secret') => accounts.create({ name, provider, credentialType: 'api_key', credentials });
const raw = id => db.prepare('SELECT credentials FROM upstream_accounts WHERE id = ?').get(id).credentials;
const put = (id, value) => db.prepare('UPDATE upstream_accounts SET credentials = ? WHERE id = ?').run(value, id);

test('unreadable rows are isolated, preserved, and visible only as redacted admin metadata', () => {
  const valid = create('valid'), other = create('other', 'anthropic');
  const bad = ['legacy-plaintext-secret', '0'.repeat(32) + ':' + '0'.repeat(32) + ':aa'];
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 0xbb), Buffer.alloc(16));
  const ciphertext = cipher.update('wrong-key-secret', 'utf8', 'hex') + cipher.final('hex');
  bad.push('0'.repeat(32) + ':' + cipher.getAuthTag().toString('hex') + ':' + ciphertext);
  const rows = bad.map((value, i) => { const a = create(`bad-${i}`); put(a.id, value); db.prepare('UPDATE upstream_accounts SET last_error = ? WHERE id = ?').run(`upstream rejected ${value}`, a.id); return a; });
  assert.deepEqual(accounts.findActiveByProvider('openai').map(a => a.id), [valid.id]);
  assert.deepEqual(accounts.findActiveByProvider('anthropic').map(a => a.id), [other.id]);
  const list = invoke('get', '/accounts'); assert.equal(list.status, 200);
  for (let i = 0; i < rows.length; i++) {
    const entry = list.body.accounts.find(a => a.id === rows[i].id);
    assert.equal(entry.credentialStatus, 'unavailable');
    const detail = invoke('get', '/accounts/:id', { id: rows[i].id });
    assert.equal(detail.status, 200); assert.equal(detail.body.account.credentialStatus, 'unavailable');
    assert.equal(raw(rows[i].id), bad[i]);
    assert.equal(JSON.stringify([list.body, detail.body]).includes(bad[i]), false);
    assert.throws(() => accounts.findById(rows[i].id));
  }
  assert.equal(list.body.accounts.find(a => a.id === valid.id).credentialStatus, 'available');
  assert.equal(JSON.stringify(list.body).includes('valid-secret'), false);
  assert.equal(invoke('get', '/stats').status, 200);
});

test('authorized admin can disable, replace, and delete unreadable credentials without exposing or silently changing them', () => {
  const disabled = create('disable'); put(disabled.id, 'legacy-disable-secret');
  db.prepare('UPDATE upstream_accounts SET last_error = ? WHERE id = ?').run('failed legacy-disable-secret', disabled.id);
  assert.equal(invoke('patch', '/accounts/:id', { id: disabled.id, auth: false, body: { credentials: 'unauthorized' } }).status, 401);
  assert.equal(raw(disabled.id), 'legacy-disable-secret');
  const result = invoke('patch', '/accounts/:id', { id: disabled.id, body: { status: 'disabled', credentials: '' } });
  assert.equal(result.status, 200); assert.equal(result.body.account.credentialStatus, 'unavailable');
  assert.equal(raw(disabled.id), 'legacy-disable-secret');
  const replaced = invoke('patch', '/accounts/:id', { id: disabled.id, body: { credentials: 'replacement-secret', status: 'active' } });
  assert.equal(replaced.status, 200); assert.equal(replaced.body.account.credentialStatus, 'available');
  assert.equal(JSON.stringify(replaced.body).includes('replacement-secret'), false);
  assert.equal(accounts.findById(disabled.id).credentials, 'replacement-secret');
  assert.equal(JSON.stringify(invoke('get', '/accounts/:id', { id: disabled.id }).body).includes('legacy-disable-secret'), false);
  assert.ok(accounts.findActiveByProvider('openai').some(a => a.id === disabled.id));
  const removed = create('remove'); put(removed.id, 'legacy-delete-secret');
  assert.equal(invoke('delete', '/accounts/:id', { id: removed.id, auth: false }).status, 401);
  assert.equal(raw(removed.id), 'legacy-delete-secret');
  assert.equal(invoke('delete', '/accounts/:id', { id: removed.id }).status, 204);
  assert.equal(accounts.findByIdAdmin(removed.id), null);
});

test('a refresh started before credential replacement cannot overwrite recovery', () => {
  const original = JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'refresh' });
  const account = accounts.create({ name: 'refresh', provider: 'openai', credentialType: 'oauth', credentials: original });
  const claim = accounts.claimRefresh(account.id, original);
  put(account.id, 'corrupt-after-refresh-start');
  const replacement = JSON.stringify({ kind: 'oauth', accessToken: 'new', refreshToken: 'new-refresh' });
  assert.equal(invoke('patch', '/accounts/:id', { id: account.id, body: { credentials: replacement } }).status, 200);
  assert.throws(() => accounts.finishRefresh(account.id, claim.credentialVersion, claim.account.credentialRevision, claim.fingerprint, claim.attemptId, 'stale-result', {}), /changed during refresh/);
  accounts.markRefreshError(account.id, claim.credentialVersion, claim.account);
  assert.equal(accounts.findById(account.id).credentials, replacement);
  assert.equal(accounts.findById(account.id).status, 'active');
});

test('usage history still blocks deletion of an unreadable account', () => {
  const account = create('history');
  const user = new UserRepository().create({ apiKeyHash: 'history-hash', name: 'history', email: 'history@test.invalid', tier: 'free', dailyLimit: 1 });
  const log = new UsageLogRepository().create({ userId: user.id, upstreamAccountId: account.id, model: 'test', provider: 'openai', inputTokens: 0, outputTokens: 0, success: true, latencyMs: 1 });
  put(account.id, 'legacy-history-secret');
  assert.equal(invoke('delete', '/accounts/:id', { id: account.id }).status, 409);
  assert.equal(raw(account.id), 'legacy-history-secret');
  assert.ok(new UsageLogRepository().findById(log.id));
  assert.equal(invoke('patch', '/accounts/:id', { id: account.id, body: { status: 'disabled' } }).status, 200);
  assert.equal(raw(account.id), 'legacy-history-secret');
});
