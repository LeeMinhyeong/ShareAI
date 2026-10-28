import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { AccountPoolManager } = await import('../src/account-pool/manager.ts');
const { refreshTokens } = await import('../src/upstream/oauth.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const { logger } = await import('../src/utils/logger.ts');
const repo = new AccountRepository();
const creds = { kind:'oauth', accessToken:'old', refreshToken:'once', expiresAt:1 };

test('invalid optional refresh fields reject before replacing credentials', async () => {
  const old = globalThis.fetch;
  try {
    for (const field of [{refresh_token:42},{refresh_token:''},{refresh_token:null},{expires_in:'3600'},{expires_in:-1},{expires_in:0},{expires_in:1e308},{id_token:{}},{id_token:''}]) {
      globalThis.fetch = async () => new Response(JSON.stringify({access_token:'new', ...field}));
      await assert.rejects(refreshTokens('openai', creds), undefined, JSON.stringify(field));
    }
  } finally { globalThis.fetch = old; }
});

test('omitted refresh token is not reused after exchange', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({access_token:'new', expires_in:3600}));
  try { assert.equal((await refreshTokens('openai', creds)).refreshToken, null); }
  finally { globalThis.fetch = old; }
});

test('refresh exception does not enter logs or escape to caller', async () => {
  const old = globalThis.fetch, log = logger.error; const entries = [];
  logger.error = (...args) => entries.push(args);
  globalThis.fetch = async () => { throw new Error('secret-access-refresh'); };
  const a = repo.create({name:'log-test', provider:'openai', credentialType:'oauth', credentials:JSON.stringify(creds)});
  try {
    await assert.rejects(resolveAuth(a), e => !String(e).includes('secret-access-refresh'));
    assert.doesNotMatch(JSON.stringify(entries), /secret-access-refresh/);
  } finally { globalThis.fetch = old; logger.error = log; }
});

test('status ABA does not let refresh failure overwrite admin state', async () => {
  const a = repo.create({name:'refresh-aba', provider:'openai', credentialType:'oauth', credentials:JSON.stringify({...creds,refreshToken:'aba'})});
  let release, enter; const started = new Promise(r => enter=r), gate = new Promise(r => release=r); const old = globalThis.fetch;
  globalThis.fetch = async () => { enter(); await gate; return new Response('{}',{status:400}); };
  try {
    const p = resolveAuth(a); await started;
    repo.update(a.id,{status:'disabled'}); repo.update(a.id,{status:'active'});
    release(); await assert.rejects(p); assert.equal(repo.findById(a.id).status,'active');
  } finally { release(); globalThis.fetch=old; }
});

test('stale failures and successes cannot change cooldown after administrator ABA', () => {
  const a = repo.create({name:'pool-aba', provider:'openai', credentialType:'api_key', credentials:'key'});
  const pool = new AccountPoolManager();
  repo.update(a.id,{status:'disabled'}); repo.update(a.id,{status:'active'});
  pool.recordFailure(a.id,{status:429,message:'old'},a,'key');
  assert.equal(repo.findById(a.id).status,'active'); assert.equal(pool.cooldownOf(a.id),0);
  const current = repo.findById(a.id);
  pool.recordFailure(a.id,{status:500,message:'current'},current,'key');
  const cooldown = pool.cooldownOf(a.id); assert.ok(cooldown > Date.now());
  pool.recordSuccess(a.id,true,a,'key'); assert.equal(pool.cooldownOf(a.id),cooldown);
});
