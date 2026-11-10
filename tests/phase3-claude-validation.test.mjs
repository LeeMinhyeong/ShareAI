import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Start the TS transformer before chdir so its Windows child cannot hold the temp directory open.
await import('../src/protocol/types.ts');
const originalDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'claude-validation-'));
process.chdir(dir);
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64); process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(2);
Object.assign(process.env, { PORT: '20100', HOST: '127.0.0.1', LOG_LEVEL: 'error', LOG_PRETTY: 'false', RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX_FREE: '20', RATE_LIMIT_MAX_PRO: '100' });
after(() => { process.chdir(originalDir); rmSync(dir, { recursive: true, force: true }); });
const { parseImportedCredential, startLogin, finishLogin, setOnLoginComplete } = await import('../src/upstream/oauth.ts');

test('Claude import rejects invalid access and refresh tokens without disclosing them', () => {
  for (const payload of [
    { accessToken: '' },
    { accessToken: '   ' },
    { accessToken: 'valid-token', refreshToken: 123 },
    { accessToken: 'valid-token', refreshToken: '' },
    { accessToken: 'valid-token', refreshToken: '  ' },
  ]) {
    assert.throws(() => parseImportedCredential('anthropic', JSON.stringify({ claudeAiOauth: payload })), /Claude/);
  }
});

test('Claude exchange rejects malformed bearer responses before bootstrap or persistence', async () => {
  const original = globalThis.fetch;
  let calls = 0, saved = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ access_token: 'bad token' })); };
  setOnLoginComplete(async () => { saved++; return 'account'; });
  try {
    const flow = await startLogin('anthropic', { name: 'test' });
    const state = new URL(flow.authUrl).searchParams.get('state');
    await assert.rejects(finishLogin(flow.flowId, `code#${state}`));
    assert.equal(calls, 1);
    assert.equal(saved, 0);
  } finally { globalThis.fetch = original; }
});

test('Claude exchange validates optional refresh, token type and expiry fields', async () => {
  const original = globalThis.fetch;
  let saved = 0, calls = 0;
  setOnLoginComplete(async () => { saved++; return 'account'; });
  try {
    for (const extra of [
      { refresh_token: null }, { refresh_token: 42 }, { refresh_token: '' },
      { token_type: null }, { token_type: 'Basic' },
      { expires_in: null }, { expires_in: '3600' }, { expires_in: 0 },
      { expires_in: -1 }, { expires_in: 1e20 }, { expires_in: 0.0001 },
      { id_token: 5 },
    ]) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ access_token: 'valid-token', ...extra })); };
      const flow = await startLogin('anthropic', { name: 'test' });
      const state = new URL(flow.authUrl).searchParams.get('state');
      await assert.rejects(finishLogin(flow.flowId, `code#${state}`), /로그인/);
      assert.equal(calls, 1);
      assert.equal(saved, 0);
    }
  } finally { globalThis.fetch = original; }
});

test('Claude imports accept optional refresh and normalize expiry', () => {
  for (const refreshToken of [undefined, null, 'refresh-value']) {
    const parsed = parseImportedCredential('anthropic', JSON.stringify({ accessToken: 'valid-token', refreshToken, expiresAt: 1700000000 }));
    const creds = JSON.parse(parsed.credentials);
    assert.equal(creds.refreshToken, refreshToken ?? null);
    assert.equal(creds.expiresAt, 1700000000000);
    assert.equal(parsed.meta.hasRefreshToken, !!refreshToken);
  }
});

test('Claude exchange accepts omitted or valid optional fields', async () => {
  const original = globalThis.fetch;
  let saved;
  setOnLoginComplete(async (_, parsed) => { saved = parsed; return 'account'; });
  try {
    for (const extra of [{}, { refresh_token: 'refresh-value', token_type: 'bEaReR', expires_in: 3600 }]) {
      let calls = 0;
      globalThis.fetch = async () => ++calls === 1
        ? new Response(JSON.stringify({ access_token: 'valid-token', ...extra }))
        : new Response(JSON.stringify({ oauth_account: { account_email: 'user@example.test' } }));
      const flow = await startLogin('anthropic', { name: 'test' });
      const state = new URL(flow.authUrl).searchParams.get('state');
      const before = Date.now();
      const result = await finishLogin(flow.flowId, `code#${state}`);
      const after = Date.now();
      const creds = JSON.parse(saved.credentials);
      assert.equal(result.status, 'done');
      assert.equal(calls, 2);
      assert.equal(creds.refreshToken, extra.refresh_token ?? null);
      if (extra.expires_in) assert.ok(creds.expiresAt >= before + 3600000 && creds.expiresAt <= after + 3600000);
      else assert.equal(creds.expiresAt, null);
    }
  } finally { globalThis.fetch = original; }
});

test('Claude exchange errors never expose response secrets', async () => {
  const original = globalThis.fetch;
  try {
    for (const [body, status] of [['SYNTHETIC_SECRET invalid json', 200], ['SYNTHETIC_SECRET', 400]]) {
      globalThis.fetch = async () => new Response(body, { status });
      const flow = await startLogin('anthropic', { name: 'test' });
      const state = new URL(flow.authUrl).searchParams.get('state');
      await assert.rejects(finishLogin(flow.flowId, `code#${state}`), err => !err.message.includes('SYNTHETIC_SECRET'));
    }
  } finally { globalThis.fetch = original; }
});
