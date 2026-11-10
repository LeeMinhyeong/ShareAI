import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';

process.chdir(mkdtempSync(path.join(process.env.TMPDIR, 'codex-pool-')));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' });
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { AccountPoolManager } = await import('../src/account-pool/manager.ts');
const repo = new AccountRepository();
const pool = new AccountPoolManager();
const api = repo.create({ name: 'api', provider: 'openai', credentialType: 'api_key', credentials: 'synthetic-key', priority: 1 });
const invalid = repo.create({ name: 'expired', provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify({ kind: 'oauth', accessToken: 'synthetic-secret', accountId: 'workspace', expiresAt: Date.now() - 1000 }), priority: 0 });

test('expired unrefreshable Codex is skipped in favor of API key without mutation', () => {
  const before = repo.findById(invalid.id);
  assert.deepEqual(pool.getCandidates('openai', 'priority').map(a => a.id), [api.id]);
  assert.deepEqual(repo.findById(invalid.id), before);
});

test('missing or invalid workspace IDs are skipped', () => {
  for (const accountId of [undefined, null, '', '  ', 'bad\r\nid', 123, {}]) {
    repo.update(invalid.id, { credentials: JSON.stringify({ kind: 'oauth', accessToken: 'fixture', accountId }) });
    assert.deepEqual(pool.getCandidates('openai', 'priority').map(a => a.id), [api.id]);
  }
});

test('expired Codex with malformed refresh token is skipped', () => {
  for (const refreshToken of ['', '   ', 42, {}]) {
    repo.update(invalid.id, {credentials: JSON.stringify({kind:'oauth', accessToken:'expired', accountId:'workspace', expiresAt:Date.now()-1000, refreshToken})});
    assert.deepEqual(pool.getCandidates('openai','priority').map(a => a.id), [api.id]);
  }
});

test('JWT expiry is honored but opaque or future tokens remain eligible', () => {
  const jwt = exp => `e30.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.signature`;
  for (const [token, expected] of [[jwt(Math.floor(Date.now()/1000)-60), false], [jwt(Math.floor(Date.now()/1000)+3600), true], ['opaque', true], ['bad.jwt.token', true]]) {
    repo.update(invalid.id, {credentials: JSON.stringify({kind:'oauth', accessToken:token, accountId:'workspace'})});
    assert.equal(pool.getCandidates('openai','priority').some(a => a.id === invalid.id), expected);
  }
});

test('refreshable expired Codex remains selectable and refreshes through normal auth', async () => {
  const {resolveAuth} = await import('../src/upstream/tokens.ts');
  repo.update(invalid.id, {credentials: JSON.stringify({kind:'oauth', accessToken:'expired-token', refreshToken:'synthetic-refresh-secret', accountId:'workspace', expiresAt:Date.now()-1000})});
  const before = repo.findById(invalid.id);
  assert.equal(pool.getCandidates('openai','priority')[0].id, invalid.id);
  assert.deepEqual(repo.findById(invalid.id), before);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    assert.equal(String(url), 'https://auth.openai.com/oauth/token');
    return new Response(JSON.stringify({access_token:'new-token', refresh_token:'new-refresh', expires_in:3600}), {status:200});
  };
  try {
    const auth = await resolveAuth(before);
    assert.equal(auth.token, 'new-token');
    assert.equal(auth.accountId, 'workspace');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('expired Codex without workspace can recover it during refresh', async () => {
  const {resolveAuth} = await import('../src/upstream/tokens.ts');
  repo.update(invalid.id, {credentials:JSON.stringify({kind:'oauth',accessToken:'expired-token',refreshToken:'recover-refresh',expiresAt:Date.now()-1000})});
  const before = repo.findById(invalid.id);
  assert.equal(pool.getCandidates('openai','priority')[0].id, invalid.id);
  const idToken = `e30.${Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'recovered'}})).toString('base64url')}.sig`;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({access_token:'new-token',id_token:idToken,refresh_token:'rotated',expires_in:3600}), {status:200});
  try { assert.equal((await resolveAuth(before)).accountId, 'recovered'); }
  finally { globalThis.fetch = previous; }
});

test('durable refresh intent excludes even unexpired credentials', () => {
  const credentials = JSON.stringify({kind:'oauth',accessToken:'valid-token',refreshToken:'intent-refresh',accountId:'workspace',expiresAt:Date.now()+3600000});
  repo.update(invalid.id, {credentials});
  repo.claimRefresh(invalid.id, credentials);
  assert.equal(pool.getCandidates('openai','priority').some(a => a.id === invalid.id), false);
});

test('control characters in workspace IDs are excluded', () => {
  for (const accountId of ['bad\u0000id', 'bad\u0001id', 'bad\u007fid']) {
    repo.update(invalid.id, {credentials:JSON.stringify({kind:'oauth',accessToken:'valid-token',accountId})});
    assert.equal(pool.getCandidates('openai','priority').some(a => a.id === invalid.id), false);
  }
});

test('invalid old bearer can be recovered by a due refresh', async () => {
  const {resolveAuth} = await import('../src/upstream/tokens.ts');
  repo.update(invalid.id, {credentials:JSON.stringify({kind:'oauth',accessToken:'',refreshToken:'blank-recover',accountId:'workspace',expiresAt:Date.now()-1000})});
  const before = repo.findById(invalid.id);
  assert.equal(pool.getCandidates('openai','priority')[0].id, invalid.id);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({access_token:'new-token',expires_in:3600}), {status:200});
  try { assert.equal((await resolveAuth(before)).token, 'new-token'); }
  finally { globalThis.fetch = previous; }
});

test('invalid bearer tokens are not selected', () => {
  for (const accessToken of ['', '  ', 'bad\u0000token', 'bad\ntoken']) {
    repo.update(invalid.id, {credentials:JSON.stringify({kind:'oauth',accessToken,accountId:'workspace'})});
    assert.equal(pool.getCandidates('openai','priority').some(a => a.id === invalid.id), false);
  }
});

test('filter is provider-specific and does not exclude API keys', () => {
  const anthropic = repo.create({name:'claude', provider:'anthropic', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth',accessToken:'claude',expiresAt:Date.now()+3_600_000}), priority:0}); // unexpired: expired non-refreshable Anthropic OAuth is excluded by its own rule
  assert.equal(pool.getCandidates('anthropic','priority')[0].id, anthropic.id);
  assert.ok(pool.getCandidates('openai','priority').some(a => a.id === api.id));
});

test('filter handles corrupt OAuth without logging secrets or changing records', async () => {
  const {logger} = await import('../src/utils/logger.ts');
  const original = {info:logger.info, warn:logger.warn, error:logger.error};
  const logged = [];
  for (const key of Object.keys(original)) logger[key] = (...args) => logged.push(args);
  try {
    repo.update(invalid.id, {credentials:'synthetic-secret-not-json'});
    const before = repo.findById(invalid.id);
    assert.deepEqual(pool.getCandidates('openai','priority').map(a => a.id), [api.id]);
    assert.deepEqual(repo.findById(invalid.id), before);
    assert.equal(JSON.stringify(logged).includes('synthetic-secret-not-json'), false);
  } finally { Object.assign(logger, original); }
});
