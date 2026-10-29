import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(3);
process.env.LOG_LEVEL = 'error';
process.env.LOG_PRETTY = 'false';

const { initDatabase, closeDatabase } = await import('../src/db/client.ts');
const { UserRepository } = await import('../src/db/repositories/users.ts');
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { hashApiKey } = await import('../src/utils/encryption.ts');
const { default: router } = await import('../src/routes/v1.ts');
initDatabase();
const repo = new UserRepository();
const app = express();
app.use(express.json());
app.use('/v1', router);
const server = http.createServer(app);
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
assert.notEqual(server.address().port, 20128);
after(async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); closeDatabase(); });
function user(key, limit = 5) {
  return repo.create({ apiKeyHash: hashApiKey(key), name: key, email: `${key}@test.invalid`, tier: 'free', dailyLimit: limit });
}
function request(path, key, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('models require valid enabled credentials but never consume quota, even at the limit', async () => {
  const key = 'models-http'; const u = user(key, 0);
  assert.equal((await request('/v1/models')).status, 401);
  assert.equal((await request('/v1/models', 'invalid')).status, 401);
  assert.equal((await request('/v1/models', key)).status, 200);
  assert.equal((await request('/v1/models', key)).status, 200);
  assert.equal(repo.getTodayUsageCount(u.id), 0);
  repo.update(u.id, { enabled: false });
  assert.equal((await request('/v1/models', key)).status, 401);
  assert.equal(repo.getTodayUsageCount(u.id), 0);
});

test('models fail closed on authentication lookup failure', async () => {
  const original = UserRepository.prototype.findByApiKeyHash;
  UserRepository.prototype.findByApiKeyHash = () => { throw new Error('fixture lookup failure'); };
  try { assert.equal((await request('/v1/models', 'lookup-failure')).status, 503); }
  finally { UserRepository.prototype.findByApiKeyHash = original; }
});

const chat = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
new AccountRepository().create({ name: 'mock provider', provider: 'openai', credentialType: 'api_key', credentials: 'sk-test-fixture' });

test('successful inference without usage is charged, and limit blocks the next request', async () => {
  const key = 'no-usage-http'; const u = user(key, 1); const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await request('/v1/chat/completions', key, chat);
    assert.equal(result.status, 200);
    assert.equal(result.body.choices[0].message.content, 'ok');
    assert.equal('usage' in result.body, false);
    assert.equal(repo.getTodayUsageCount(u.id), 1);
    assert.equal((await request('/v1/chat/completions', key, chat)).status, 429);
    assert.equal(upstreamCalls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('usage-bearing inference counts exactly once, not once per usage log', async () => {
  const key = 'usage-http'; const u = user(key, 2); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1},"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await request('/v1/chat/completions', key, chat);
    assert.equal(result.status, 200);
    assert.equal(result.body.usage.total_tokens, 3);
    assert.equal(repo.getTodayUsageCount(u.id), 1);
    assert.equal((await request('/v1/chat/completions', key, chat)).status, 200);
    assert.equal(repo.getTodayUsageCount(u.id), 2);
    assert.equal((await request('/v1/chat/completions', key, chat)).status, 429);
  } finally { globalThis.fetch = originalFetch; }
});

test('upstream failure and unimplemented inference retain reservations', async () => {
  const key = 'failure-http'; const u = user(key); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('failure', { status: 500 });
  try {
    assert.equal((await request('/v1/chat/completions', key, chat)).status, 500);
    assert.equal(repo.getTodayUsageCount(u.id), 1);
    assert.equal((await request('/v1/messages', key, {})).status, 501);
    assert.equal(repo.getTodayUsageCount(u.id), 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('client disconnect after provider starts retains its reservation', async () => {
  const key = 'disconnect-http'; const u = user(key); const originalFetch = globalThis.fetch;
  let providerStarted, providerAborted;
  const started = new Promise(resolve => { providerStarted = resolve; });
  const aborted = new Promise(resolve => { providerAborted = resolve; });
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    providerStarted();
    options.signal.addEventListener('abort', () => { providerAborted(); reject(new Error('aborted')); }, { once: true });
  });
  try {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
    const clientError = new Promise(resolve => req.once('error', resolve));
    req.end(JSON.stringify(chat));
    await started;
    assert.equal(repo.getTodayUsageCount(u.id), 1);
    req.destroy();
    await aborted;
    assert.equal((await clientError).code, 'ECONNRESET');
    assert.equal(repo.getTodayUsageCount(u.id), 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('inference fails closed if user is disabled or deleted immediately before reservation', async () => {
  const original = UserRepository.prototype.reserveDailyQuota;
  for (const action of ['disabled', 'deleted']) {
    const key = `race-${action}`; const u = user(key);
    let upstreamCalled = false; const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { upstreamCalled = true; throw new Error('unexpected upstream'); };
    UserRepository.prototype.reserveDailyQuota = function(hash) {
      if (action === 'disabled') repo.update(u.id, { enabled: false });
      else initDatabase().prepare('DELETE FROM users WHERE id = ?').run(u.id);
      return original.call(this, hash);
    };
    try {
      assert.equal((await request('/v1/chat/completions', key, chat)).status, 401);
      assert.equal(repo.getTodayUsageCount(u.id), 0);
      assert.equal(upstreamCalled, false);
    } finally { UserRepository.prototype.reserveDailyQuota = original; globalThis.fetch = originalFetch; }
  }
});
