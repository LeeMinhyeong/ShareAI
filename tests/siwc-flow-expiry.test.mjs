import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Start the TS transformer before chdir so its Windows child cannot hold the temp directory open.
await import('../src/protocol/types.ts');
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'siwc-expiry-'));
const originalCwd = process.cwd();
process.once('exit', () => { process.chdir(originalCwd); rmSync(dir, { recursive: true, force: true }); });
process.chdir(dir);
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.ADMIN_API_KEY = 'test-admin-key-'.repeat(2);
Object.assign(process.env, { PORT: '20100', HOST: '127.0.0.1', LOG_LEVEL: 'error', LOG_PRETTY: 'false', RATE_LIMIT_WINDOW_MS: '60000', RATE_LIMIT_MAX_FREE: '20', RATE_LIMIT_MAX_PRO: '100' });
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const { createSiwcRouter, stopSiwc } = await import('../src/upstream/siwc-login.ts');
const { getDb, closeDatabase } = await import('../src/db/client.ts');
const originalFetch = globalThis.fetch, originalNow = Date.now;

async function waitForMockEntry(entered, callback) {
  let timer;
  try {
    await Promise.race([
      entered,
      callback.then(response => { throw new Error(`Callback completed before mock entry (status ${response.status})`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for mock entry')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

test('exchange that completes after flow expiry cannot persist credentials', async () => {
  const app = express(); app.use(express.json()); app.use('/siwc', createSiwcRouter((_req,_res,next) => next()));
  const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',() => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/siwc`;
  let release, entered; const enteredPromise = new Promise(r => { entered = r; });
  const abort = new AbortController();
  try {
    const started = await originalFetch(base+'/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'late'})});
    const {authorizationUrl} = await started.json(); const auth = new URL(authorizationUrl);
    const key = generateKeyPairSync('rsa',{modulusLength:2048});
    const jwk = {...key.publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'};
    const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now()/1000);
    const data = `${encode({alg:'RS256',kid:'test'})}.${encode({iss:'https://auth.openai.com',aud:'client',sub:'sub',nonce:auth.searchParams.get('nonce'),iat:now,exp:now+3600})}`;
    const idToken = `${data}.${sign('RSA-SHA256',Buffer.from(data),key.privateKey).toString('base64url')}`;
    globalThis.fetch = async url => {
      if (url.endsWith('jwks.json')) return Response.json({keys:[jwk]});
      entered(); await new Promise(r => { release = r; });
      return Response.json({access_token:'access',refresh_token:'refresh',id_token:idToken,token_type:'Bearer',expires_in:3600,scope:'openid offline_access resource.invoke chatgpt.tokens.use.direct'});
    };
    const callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({state:auth.searchParams.get('state'),code:'code',client_id:'client'});
    const pending = originalFetch(callback, { signal: abort.signal }); await waitForMockEntry(enteredPromise, pending);
    Date.now = () => originalNow()+600001; release();
    assert.equal((await pending).status,400);
    const db = getDb();
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get();
    assert.ok(!exists || db.prepare('SELECT count(*) AS n FROM siwc_accounts').get().n === 0);
    Date.now = originalNow;
    const started2 = await originalFetch(base+'/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'cancelled'})});
    const flow2 = await started2.json(); const auth2 = new URL(flow2.authorizationUrl);
    const data2 = `${encode({alg:'RS256',kid:'test'})}.${encode({iss:'https://auth.openai.com',aud:'client',sub:'sub',nonce:auth2.searchParams.get('nonce'),iat:now,exp:now+3600})}`;
    const id2 = `${data2}.${sign('RSA-SHA256',Buffer.from(data2),key.privateKey).toString('base64url')}`;
    let entered2; const enteredPromise2 = new Promise(r => { entered2 = r; });
    globalThis.fetch = async url => {
      if (url.endsWith('jwks.json')) return Response.json({keys:[jwk]});
      entered2(); await new Promise(r => { release = r; });
      return Response.json({access_token:'access',refresh_token:'refresh',id_token:id2,token_type:'Bearer',expires_in:3600,scope:'openid offline_access resource.invoke chatgpt.tokens.use.direct'});
    };
    const callback2 = new URL(auth2.searchParams.get('redirect_uri'));
    callback2.search = new URLSearchParams({state:auth2.searchParams.get('state'),code:'code',client_id:'client'});
    const pending2 = originalFetch(callback2, { signal: abort.signal }); await waitForMockEntry(enteredPromise2, pending2);
    const cancelled = await originalFetch(`${base}/${flow2.flowId}/cancel`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    release(); assert.equal(cancelled.status,200);
    assert.equal((await pending2).status,400);
    const exists2 = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get();
    assert.ok(!exists2 || db.prepare('SELECT count(*) AS n FROM siwc_accounts').get().n === 0);
  } finally {
    release?.(); abort.abort(); Date.now = originalNow; globalThis.fetch = originalFetch;
    server.closeAllConnections();
    try { await stopSiwc(); } finally { try { await new Promise(r => server.close(r)); } finally { closeDatabase(); } }
  }
});
