import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const repo = new AccountRepository();

test('failed stale refresh does not disable newly replaced credentials', async () => {
  const account = repo.create({ name: 'cas-failure', provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 }) });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { started(); await gate; return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }); };
  try {
    const result = resolveAuth(account);
    await entered;
    repo.update(account.id, { credentials: 'admin-new-key', credentialType: 'api_key', status: 'active' });
    release();
    await assert.rejects(result);
    assert.equal(repo.findById(account.id).status, 'active');
    assert.equal(repo.findById(account.id).credentials, 'admin-new-key');
  } finally { release(); globalThis.fetch = originalFetch; }
});

test('refresh preserves independently updated metadata', async () => {
  const account = repo.create({ name: 'cas-meta', provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'meta-refresh', expiresAt: 1 }), meta: { source: 'old' } });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { started(); await gate; return new Response(JSON.stringify({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 }), { status: 200 }); };
  try {
    const result = resolveAuth(account);
    await entered;
    repo.update(account.id, { meta: { source: 'admin' } });
    release();
    await result;
    assert.equal(repo.findById(account.id).meta.source, 'admin');
    assert.equal(JSON.parse(repo.findById(account.id).credentials).refreshToken, 'rotated-refresh');
  } finally { release(); globalThis.fetch = originalFetch; }
});

test('administrator credentials survive a concurrent token rotation', async () => {
  const account = repo.create({ name: 'cas', provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'cas-refresh', expiresAt: 1 }) });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { started(); await gate; return new Response(JSON.stringify({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 }), { status: 200 }); };
  try {
    const result = resolveAuth(account);
    await entered;
    repo.update(account.id, { credentialType: 'api_key', credentials: 'admin-new-key', meta: { source: 'admin' } });
    release();
    await assert.rejects(result);
    const saved = repo.findById(account.id);
    assert.equal(saved.credentials, 'admin-new-key');
    assert.equal(saved.credentialType, 'api_key');
    assert.equal(saved.meta.source, 'admin');
  } finally { release(); globalThis.fetch = originalFetch; }
});
