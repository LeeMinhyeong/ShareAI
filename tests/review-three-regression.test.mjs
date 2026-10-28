import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { AccountPoolManager } = await import('../src/account-pool/manager.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const { refreshTokens } = await import('../src/upstream/oauth.ts');
const repo = new AccountRepository();

test('administrator reactivation or credential replacement invalidates existing cooldown', () => {
  for (const change of ['reactivate','credentials']) {
    const account = repo.create({name:`cooldown-${change}`,provider:'google',credentialType:'api_key',credentials:'key'});
    const pool = new AccountPoolManager();
    pool.recordFailure(account.id,{status:500,message:'failure'},account,'key');
    assert.ok(pool.cooldownOf(account.id) > Date.now());
    if (change === 'reactivate') { repo.update(account.id,{status:'disabled'}); repo.update(account.id,{status:'active'}); }
    else repo.update(account.id,{credentials:'replacement'});
    assert.ok(pool.getCandidates('google','priority').some(a => a.id === account.id));
    assert.equal(pool.cooldownOf(account.id),0, change);
  }
});

test('credential replacement with the same access token rejects an old failure', () => {
  const original = JSON.stringify({kind:'oauth',accessToken:'same',refreshToken:'first'});
  const replacement = JSON.stringify({kind:'oauth',accessToken:'same',refreshToken:'second'});
  const account = repo.create({name:'credential-aba',provider:'openai',credentialType:'oauth',credentials:original});
  repo.update(account.id, {credentials:replacement});
  const pool = new AccountPoolManager();
  pool.recordFailure(account.id,{status:401,message:'stale'},account,'same');
  assert.equal(repo.findById(account.id).status,'active');
  assert.equal(pool.cooldownOf(account.id),0);
});

test('omitted token_type and case-insensitive Bearer are accepted', async () => {
  const old = globalThis.fetch;
  try {
    for (const provider of ['openai','anthropic']) for (const body of [{access_token:'valid._~+/-='},{access_token:'valid',token_type:'bEaReR'}]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body));
      assert.equal((await refreshTokens(provider,{kind:'oauth',accessToken:'old',refreshToken:'refresh'})).accessToken,body.access_token);
    }
  } finally { globalThis.fetch = old; }
});

test('concurrent server failure does not suppress a later authentication failure', () => {
  for (const status of [401, 403]) {
    const account = repo.create({name:`concurrent-${status}`,provider:'anthropic',credentialType:'api_key',credentials:'key'});
    const pool = new AccountPoolManager();
    const secondObservation = repo.findById(account.id);
    pool.recordFailure(account.id,{status:500,message:'server failure'},account,'key');
    pool.recordFailure(account.id,{status,message:'authentication failure'},secondObservation,'key');
    assert.equal(repo.findById(account.id).status,'error');
    assert.equal(repo.findById(account.id).lastError,'authentication failure');
    assert.ok(pool.cooldownOf(account.id) >= Date.now() + 9000);
  }
});

test('concurrent quota failure does not suppress a later authentication failure', () => {
  const account = repo.create({name:'quota-auth-concurrent',provider:'anthropic',credentialType:'api_key',credentials:'key'});
  const pool = new AccountPoolManager();
  pool.recordFailure(account.id,{status:429,message:'quota'},account,'key');
  pool.recordFailure(account.id,{status:401,message:'auth'},account,'key');
  assert.equal(repo.findById(account.id).status,'error');
});

test('consecutive current failures keep exponential backoff', () => {
  const account = repo.create({name:'backoff',provider:'anthropic',credentialType:'api_key',credentials:'key'});
  const pool = new AccountPoolManager();
  pool.recordFailure(account.id,{status:500,message:'first'},account,'key');
  pool.recordFailure(account.id,{status:500,message:'second'},repo.findById(account.id),'key');
  assert.ok(pool.cooldownOf(account.id) >= Date.now() + 9000);
});

test('refresh rejects non-Bearer or header-unsafe tokens before persistence', async () => {
  const old = globalThis.fetch;
  try {
    for (const [i, body] of [{access_token:'new',token_type:'MAC'}, {access_token:'new',token_type:null}, {access_token:'bad\r\ninjected: x',token_type:'Bearer'}].entries()) {
      const creds = JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:`refresh-${i}`,expiresAt:1});
      const account = repo.create({name:`unsafe-${i}`,provider:'openai',credentialType:'oauth',credentials:creds});
      globalThis.fetch = async () => new Response(JSON.stringify(body));
      await assert.rejects(resolveAuth(account));
      assert.equal(repo.findById(account.id).credentials, creds);
    }
  } finally { globalThis.fetch = old; }
});
