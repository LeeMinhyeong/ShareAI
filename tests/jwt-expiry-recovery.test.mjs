import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const repo = new AccountRepository();
const jwt = exp => `e30.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.sig`;

test('ordinary request recovers after a refresh saved an expired JWT with future expiresAt', async () => {
  const account = repo.create({ name:'jwt-recovery', provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:'old', refreshToken:'initial', expiresAt:1}) });
  const original = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, opts) => {
    sent.push(new URLSearchParams(opts.body).get('refresh_token'));
    return new Response(JSON.stringify(sent.length === 1
      ? {access_token:jwt(Math.floor(Date.now()/1000)-60), refresh_token:'rotated', expires_in:3600}
      : {access_token:jwt(Math.floor(Date.now()/1000)+3600), refresh_token:'final', expires_in:3600}));
  };
  try {
    await assert.rejects(resolveAuth(account), /expired/i);
    assert.equal(JSON.parse(repo.findById(account.id).credentials).refreshToken, 'rotated');
    const result = await resolveAuth(repo.findById(account.id));
    assert.deepEqual(sent, ['initial', 'rotated']);
    assert.equal(result.token, JSON.parse(repo.findById(account.id).credentials).accessToken);
    assert.equal(JSON.parse(repo.findById(account.id).credentials).refreshToken, 'final');
  } finally { globalThis.fetch = original; }
});

test('future JWT exp inside skew and unusable JWT exp do not trigger rotation', async () => {
  const tokens = [jwt(Math.floor(Date.now()/1000)+60), 'opaque', 'a.invalid.c', jwt('1'), jwt(null)];
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected network access'); };
  try {
    for (const [index, token] of tokens.entries()) {
      const account = repo.create({name:`jwt-fallback-${index}`, provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:token, refreshToken:`unused-${index}`, expiresAt:Date.now()+3600000})});
      assert.equal((await resolveAuth(account)).token, token);
    }
  } finally { globalThis.fetch = original; }
});

test('late 401 cannot rotate an internally replaced expired JWT', async () => {
  const account = repo.create({name:'jwt-stale-401', provider:'openai', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth', accessToken:'before', refreshToken:'before-refresh', expiresAt:Date.now()+3600000})});
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({access_token:jwt(Math.floor(Date.now()/1000)-60), refresh_token:'protected-rotation', expires_in:3600})); };
  try {
    await assert.rejects(resolveAuth(account, {forceRefresh:true, rejectedToken:'before'}), /expired/i);
    await assert.rejects(resolveAuth(account, {forceRefresh:true, rejectedToken:'before'}), /expired/i);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(repo.findById(account.id).credentials).refreshToken, 'protected-rotation');
  } finally { globalThis.fetch = original; }
});
