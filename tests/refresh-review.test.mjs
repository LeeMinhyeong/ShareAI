import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const { refreshTokens } = await import('../src/upstream/oauth.ts');
const repo = new AccountRepository();
const credentials = JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 });

test('invalid successful responses cannot replace stored credentials', async () => {
  const oldFetch = globalThis.fetch;
  try {
    for (const body of [{}, { access_token: '' }, { access_token: '   ' }, { access_token: 42 }]) {
      const uniqueCredentials = JSON.stringify({ ...JSON.parse(credentials), refreshToken: `invalid-${Math.random()}` });
      const account = repo.create({ name: `invalid-${Math.random()}`, provider: 'openai', credentialType: 'oauth', credentials: uniqueCredentials });
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await assert.rejects(resolveAuth(account));
      assert.equal(repo.findById(account.id).credentials, uniqueCredentials);
    }
  } finally { globalThis.fetch = oldFetch; }
});

test('administrator disable survives an unrecoverable refresh failure', async () => {
  const account = repo.create({ name: 'disabled-race', provider: 'openai', credentialType: 'oauth', credentials });
  let release, started;
  const entered = new Promise(r => { started = r; });
  const gate = new Promise(r => { release = r; });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { started(); await gate; return new Response('{"error":"invalid_grant"}', { status: 400 }); };
  try {
    const pending = resolveAuth(account);
    await entered;
    repo.update(account.id, { status: 'disabled', lastError: 'administrator' });
    release();
    await assert.rejects(pending);
    assert.equal(repo.findById(account.id).status, 'disabled');
    assert.equal(repo.findById(account.id).lastError, 'administrator');
  } finally { release(); globalThis.fetch = oldFetch; }
});

test('refresh fetch receives a deadline and aborts a stalled request', async () => {
  const oldFetch = globalThis.fetch;
  const oldTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => oldTimeout(30);
  let signalSeen = false;
  globalThis.fetch = async (_url, options) => {
    signalSeen = !!options.signal;
    if (!signalSeen) return new Promise(() => {});
    return await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  let watchdog;
  try {
    const outcome = await Promise.race([refreshTokens('openai', JSON.parse(credentials)).then(() => 'success', () => 'aborted'), new Promise(r => { watchdog = setTimeout(() => r('hung'), 150); })]);
    assert.equal(signalSeen, true, 'missing abort signal');
    assert.equal(outcome, 'aborted');
  } finally { clearTimeout(watchdog); globalThis.fetch = oldFetch; AbortSignal.timeout = oldTimeout; }
});
