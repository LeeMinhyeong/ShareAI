import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const repo = new AccountRepository();
const create = (name, creds) => repo.create({ name, provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', ...creds}) });
const jwt = exp => `e30.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.sig`;

test('expired refresh result is persisted safely but never returned', async () => {
  const account = create('expired-result', {accessToken:'old', refreshToken:'refresh-expired-result', expiresAt:1});
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({access_token:jwt(Math.floor(Date.now()/1000)-60), refresh_token:'rotated-expired-result'})); };
  try {
    await assert.rejects(resolveAuth(account), /expired/i);
    const stored = JSON.parse(repo.findById(account.id).credentials);
    assert.equal(stored.refreshToken, 'rotated-expired-result');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('late 401 reuses internally refreshed different token inside skew without rotating', async () => {
  const account = create('late-skew', {accessToken:'old-late', refreshToken:'refresh-late', expiresAt:Date.now()+3600000});
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({access_token:'fresh-late', refresh_token:'rotated-late', expires_in:120})); };
  try {
    const first = await resolveAuth(account, {forceRefresh:true, rejectedToken:'old-late'});
    const late = await resolveAuth(account, {forceRefresh:true, rejectedToken:'old-late'});
    assert.equal(first.token, 'fresh-late');
    assert.equal(late.token, 'fresh-late');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('expired JWT is not returned even when refresh reports a future expires_in', async () => {
  const account = create('conflicting-expiry', {accessToken:'old-conflict', refreshToken:'refresh-conflict', expiresAt:1});
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({access_token:jwt(Math.floor(Date.now()/1000)-60), refresh_token:'rotated-conflict', expires_in:3600}));
  try {
    await assert.rejects(resolveAuth(account), /expired/i);
    assert.equal(JSON.parse(repo.findById(account.id).credentials).refreshToken, 'rotated-conflict');
  } finally { globalThis.fetch = original; }
});

test('ordinary expired credential without refresh token is rejected', async () => {
  const account = create('expired-no-refresh', {accessToken:'expired', refreshToken:null, expiresAt:1});
  await assert.rejects(resolveAuth(account), /expired/i);
});

test('late 401 rejects an expired internally refreshed different token without another rotation', async () => {
  const account = create('late-expired', {accessToken:'old-expired-late', refreshToken:'refresh-expired-late', expiresAt:Date.now()+3600000});
  const original = globalThis.fetch, realNow = Date.now; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({access_token:'fresh-expired-late', refresh_token:'rotated-expired-late', expires_in:1})); };
  try {
    await resolveAuth(account, {forceRefresh:true, rejectedToken:'old-expired-late'});
    Date.now = () => realNow()+2000;
    await assert.rejects(resolveAuth(account, {forceRefresh:true, rejectedToken:'old-expired-late'}), /expired/i);
    assert.equal(calls, 1);
  } finally { Date.now = realNow; globalThis.fetch = original; }
});
