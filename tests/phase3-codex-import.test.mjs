import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Start the TS transformer before chdir so its Windows child cannot hold the temp directory open.
await import('../src/protocol/types.ts');
const originalDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'codex-import-'));
process.chdir(dir);
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64); process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(2);
Object.assign(process.env, { PORT: '20100', HOST: '127.0.0.1', LOG_LEVEL: 'error', LOG_PRETTY: 'false', RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX_FREE: '20', RATE_LIMIT_MAX_PRO: '100' });
after(() => { process.chdir(originalDir); rmSync(dir, { recursive: true, force: true }); });
const { parseImportedCredential } = await import('../src/upstream/oauth.ts');

test('Codex import retains top-level refresh and account fields alongside nested tokens', () => {
  const result = parseImportedCredential('openai', JSON.stringify({
    tokens: { access_token: 'fixture-access' },
    refresh_token: 'fixture-refresh', account_id: 'fixture-account'
  }));
  assert.equal(result.credentialType, 'oauth');
  const creds = JSON.parse(result.credentials);
  assert.equal(creds.accessToken, 'fixture-access');
  assert.equal(creds.refreshToken, 'fixture-refresh');
  assert.equal(creds.accountId, 'fixture-account');
});

test('Codex import finds the account ID in the access token when the ID-token claim lacks it', () => {
  const jwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
  const result = parseImportedCredential('openai', JSON.stringify({ tokens: {
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })
  }}));
  assert.equal(JSON.parse(result.credentials).accountId, 'fixture-account');
});
