import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const dir = mkdtempSync(join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch', 'siwc-logout-'));
process.chdir(dir);
process.env.NODE_ENV = 'test'; process.env.DATABASE_URL = 'sqlite:./test.db';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); process.env.ADMIN_API_KEY = 'synthetic-admin-key-for-testing';
const { default: router } = await import('../src/routes/admin.ts');
const { getDb, closeDatabase } = await import('../src/db/client.ts');
const { CredentialVault } = await import('../src/utils/encryption.ts');
const { SiwcStore } = await import('../src/upstream/siwc-store.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const realFetch = globalThis.fetch;
const headers = { authorization: `Bearer ${process.env.ADMIN_API_KEY}`, 'content-type': 'application/json' };
const credential = {issuer:'https://auth.openai.com', subject:'test-sub', clientId:'test-client', accessToken:'synthetic-access', refreshToken:'synthetic-refresh', idToken:'synthetic-id', tokenType:'Bearer', expiresIn:3600, scopes:['offline_access'], savedAt:'2026-01-01T00:00:00.000Z'};

await test('admin logout invalidates locally before discovery and securely revokes', async () => {
  const app = express(); app.use(express.json()); app.use('/admin',router);
  const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',()=>resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/admin/siwc`;
  const db = getDb(), store = new SiwcStore(db,new CredentialVault());
  db.exec("CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('logout-test','test')");
  store.create('logout-test',credential);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(store.read('logout-test'),null); assert.equal(init.redirect,'error'); assert.ok(init.signal);
    if (calls === 1) { assert.equal(url,'https://auth.openai.com/.well-known/openid-configuration'); return Response.json({revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'}); }
    assert.equal(url,'https://auth.openai.com/api/accounts/oauth/revoke'); assert.equal(init.method,'POST');
    const form = new URLSearchParams(init.body); assert.equal(form.get('token'),credential.refreshToken); assert.equal(form.get('client_id'),credential.clientId); assert.equal(form.get('token_type_hint'),'refresh_token');
    return new Response(null,{status:200});
  };
  try {
    const denied = await realFetch(`${base}/accounts/logout-test/logout`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); assert.equal(denied.status,401); assert.equal(store.read('logout-test').refreshToken,credential.refreshToken);
    const res = await realFetch(`${base}/accounts/logout-test/logout`,{method:'POST',headers,body:'{}'});
    assert.equal(res.status,200); assert.match(res.headers.get('cache-control'),/no-store/);
    const text = await res.text(); assert.deepEqual(JSON.parse(text),{localSignedOut:true,remoteRevoked:true});
    for (const secret of [credential.accessToken,credential.refreshToken,credential.idToken,credential.clientId]) assert.ok(!text.includes(secret));
    assert.equal(calls,2); assert.equal(store.read('logout-test'),null);
    const replay = await realFetch(`${base}/accounts/logout-test/logout`,{method:'POST',headers,body:'{}'});
    assert.equal(replay.status,409); assert.equal(calls,2);
    assert.equal(store.readRegistrationSnapshot('logout-test').identity.clientId,credential.clientId);
    const create = (id, suffix) => { db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run(id,id); store.create(id,{...credential,clientId:'client-'+suffix,refreshToken:'refresh-'+suffix}); };
    const logout = async id => { const response = await realFetch(`${base}/accounts/${id}/logout`,{method:'POST',headers,body:'{}'}); assert.equal(response.status,200); return response.json(); };
    create('intent','intent'); const intent = store.claimRefresh('intent',store.readSnapshot('intent'));
    globalThis.fetch = async (url) => url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
    assert.equal((await logout('intent')).remoteRevoked,false);
    assert.throws(() => store.finishRefresh('intent',intent,{...intent.credential,refreshToken:'rotated'}));
    const reopened = new SiwcStore(db,new CredentialVault()); assert.equal(reopened.read('intent'),null);
    create('fail','fail'); globalThis.fetch = async () => { throw new Error('synthetic-refresh-fail'); };
    assert.equal((await logout('fail')).remoteRevoked,false); assert.equal(store.read('fail'),null);
    create('hostile','hostile'); let hostileCalls = 0;
    globalThis.fetch = async () => { hostileCalls++; return Response.json({revocation_endpoint:'https://evil.example/revoke'}); };
    assert.equal((await logout('hostile')).remoteRevoked,false); assert.equal(hostileCalls,1);
    create('timeout','timeout'); let timedSignal;
    globalThis.fetch = async (_url, init) => { timedSignal=init.signal; return new Promise(()=>{}); };
    assert.equal((await logout('timeout')).remoteRevoked,false); assert.equal(timedSignal.aborted,true); assert.equal(store.read('timeout'),null);
    create('stale','stale');
    const start = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'stale'})});
    const stale = new URL((await start.json()).authorizationUrl);
    globalThis.fetch = async url => url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
    assert.equal((await logout('stale')).remoteRevoked,true);
    const rsa = generateKeyPairSync('rsa',{modulusLength:2048});
    const jwk = {...rsa.publicKey.export({format:'jwk'}),kid:'key',alg:'RS256',use:'sig'};
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = (nonce, client='client-stale') => { const now=Math.floor(Date.now()/1000); const value=`${encoded({alg:'RS256',kid:'key'})}.${encoded({iss:'https://auth.openai.com',aud:client,sub:'test-sub',nonce,iat:now,exp:now+300})}`; return `${value}.${sign('RSA-SHA256',Buffer.from(value),rsa.privateKey).toString('base64url')}`; };
    let nonce=stale.searchParams.get('nonce');
    globalThis.fetch = async url => url.includes('jwks.json') ? Response.json({keys:[jwk]}) : Response.json({access_token:'new-access',refresh_token:'new-refresh',id_token:token(nonce),token_type:'Bearer',expires_in:3600,scope:'openid offline_access'});
    const callback = auth => { const u = new URL(auth.searchParams.get('redirect_uri')); u.search = new URLSearchParams({state:auth.searchParams.get('state'),code:'synthetic'}); return u; };
    assert.equal((await realFetch(callback(stale))).status,400); assert.equal(store.read('stale'),null);
    const restart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'stale'})});
    const fresh = new URL((await restart.json()).authorizationUrl); assert.equal(fresh.searchParams.get('client_id'),'client-stale'); assert.equal(fresh.searchParams.get('id_token_hint'),null);
    nonce=fresh.searchParams.get('nonce'); assert.equal((await realFetch(callback(fresh))).status,200); assert.equal(store.read('stale').refreshToken,'new-refresh');
    globalThis.fetch = async url => url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
    assert.equal((await logout('stale')).remoteRevoked,true);
    create('post-fence','post-fence');
    let releaseRevoke, enteredRevoke;
    const revokeEntered = new Promise(resolve => { enteredRevoke=resolve; });
    const revokeGate = new Promise(resolve => { releaseRevoke=resolve; });
    globalThis.fetch = async url => { if (url.includes('openid-configuration')) { enteredRevoke(); await revokeGate; return Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}); } return new Response(null,{status:200}); };
    const pendingLogout = logout('post-fence'); await revokeEntered;
    const afterFence = store.readRegistrationSnapshot('post-fence');
    store.claimAuthorization('post-fence',afterFence.revision);
    releaseRevoke(); assert.equal((await pendingLogout).remoteRevoked,false);
    create('racing','racing');
    const racingStart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'racing'})});
    const racing = new URL((await racingStart.json()).authorizationUrl);
    let releaseExchange, signalExchange;
    const entered = new Promise(resolve => { signalExchange=resolve; });
    const gate = new Promise(resolve => { releaseExchange=resolve; });
    globalThis.fetch = async url => {
      if (url.includes('oauth/token')) { signalExchange(); await gate; return Response.json({access_token:'race-access',refresh_token:'race-refresh',id_token:token(racing.searchParams.get('nonce'),'client-racing'),token_type:'Bearer',expires_in:3600,scope:'openid offline_access'}); }
      if (url.includes('jwks.json')) return Response.json({keys:[jwk]});
      return url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
    };
    const callbackResult = realFetch(callback(racing));
    await entered;
    try { assert.equal((await logout('racing')).remoteRevoked,false); }
    finally { releaseExchange(); assert.equal((await callbackResult).status,400); }
    assert.equal(store.read('racing'),null);
    create('cross-race','cross-race');
    const crossStart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'cross-race'})});
    const cross = new URL((await crossStart.json()).authorizationUrl);
    let releaseCross, enteredCross;
    const crossEntered = new Promise(resolve => { enteredCross=resolve; });
    const crossGate = new Promise(resolve => { releaseCross=resolve; });
    globalThis.fetch = async url => {
      if (url.includes('oauth/token')) { enteredCross(); await crossGate; return Response.json({access_token:'cross-access',refresh_token:'cross-refresh',id_token:token(cross.searchParams.get('nonce'),'client-cross-race'),token_type:'Bearer',expires_in:3600,scope:'openid offline_access'}); }
      if (url.includes('jwks.json')) return Response.json({keys:[jwk]});
      throw Error('unexpected fetch');
    };
    const crossCallback = realFetch(callback(cross)); await crossEntered;
    const child = fork(new URL('./siwc-logout-race-worker.mjs',import.meta.url),[join(dir,'test.db'),'encrypted-logout','cross-race'],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','inherit','ipc']});
    const childExit = once(child,'exit');
    try { assert.deepEqual((await once(child,'message'))[0],{remoteUncertain:true}); await childExit; }
    finally { releaseCross(); assert.equal((await crossCallback).status,400); if (child.connected) child.kill(); }
    assert.equal(store.read('cross-race'),null);
    create('rejected','rejected');
    const rejectedStart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'rejected'})});
    const rejected = new URL((await rejectedStart.json()).authorizationUrl);
    globalThis.fetch = async () => Response.json({error:'invalid_grant'},{status:400});
    assert.equal((await realFetch(callback(rejected))).status,400);
    assert.equal(db.prepare('SELECT count(*) AS n FROM siwc_authorization_intents WHERE account_id=?').get('rejected').n,0);
    const recoveredStart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'rejected'})});
    const recovered = new URL((await recoveredStart.json()).authorizationUrl);
    globalThis.fetch = async url => url.includes('jwks.json') ? Response.json({keys:[jwk]}) : Response.json({access_token:'recovered-access',refresh_token:'recovered-refresh',id_token:token(recovered.searchParams.get('nonce'),'client-rejected'),token_type:'Bearer',expires_in:3600,scope:'openid offline_access'});
    assert.equal((await realFetch(callback(recovered))).status,200);
    globalThis.fetch = async url => url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
    assert.equal((await logout('rejected')).remoteRevoked,true);
    for (const [kind, failure] of [
      ['network', async () => { throw new Error('network failure'); }],
      ['exchange-timeout', async () => { throw new DOMException('aborted','AbortError'); }],
      ['contradictory', async () => Response.json({error:'invalid_grant',access_token:'synthetic-token'},{status:400})],
      ['other-error', async () => Response.json({error:'invalid_request'},{status:400})],
      ['server-error', async () => Response.json({error:'invalid_grant'},{status:500})],
      ['malformed', async () => new Response('{',{status:400})],
      ['unexpected-success', async () => Response.json({error:'invalid_grant'})],
    ]) {
      create(kind,kind);
      const started = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:kind})});
      const auth = new URL((await started.json()).authorizationUrl);
      globalThis.fetch = failure;
      assert.equal((await realFetch(callback(auth))).status,400);
      assert.equal(db.prepare('SELECT count(*) AS n FROM siwc_authorization_intents WHERE account_id=?').get(kind).n,1,kind);
      globalThis.fetch = async url => url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
      assert.equal((await logout(kind)).remoteRevoked,false,kind);
    }
    create('rejection-race','rejection-race');
    const raceStart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'rejection-race'})});
    const raceAuth = new URL((await raceStart.json()).authorizationUrl);
    let enteredRefusal, releaseRefusal;
    const refusalEntered = new Promise(resolve => { enteredRefusal=resolve; });
    const refusalGate = new Promise(resolve => { releaseRefusal=resolve; });
    globalThis.fetch = async () => { enteredRefusal(); await refusalGate; return Response.json({error:'invalid_grant'},{status:400}); };
    const refusalCallback = realFetch(callback(raceAuth)); await refusalEntered;
    const raceWorker = fork(new URL('./siwc-logout-race-worker.mjs',import.meta.url),[join(dir,'test.db'),'encrypted-logout','rejection-race'],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','inherit','ipc']});
    const raceExit = once(raceWorker,'exit');
    try { assert.deepEqual((await once(raceWorker,'message'))[0],{remoteUncertain:true}); await raceExit; }
    finally { releaseRefusal(); assert.equal((await refusalCallback).status,400); if (raceWorker.connected) raceWorker.kill(); }
    assert.equal(store.read('rejection-race'),null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM siwc_authorization_intents WHERE account_id=?').get('rejection-race').n,0);
    create('pending','pending');
    const pendingStart = await realFetch(`${base}/start`,{method:'POST',headers,body:JSON.stringify({accountId:'pending'})});
    const pending = await pendingStart.json();
    globalThis.fetch = async url => url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});
    assert.equal((await logout('pending')).remoteRevoked,true);
    assert.equal((await (await realFetch(`${base}/${pending.flowId}`,{headers})).json()).status,'pending');
    const cancelled = await realFetch(`${base}/${pending.flowId}/cancel`,{method:'POST',headers,body:'{}'}); assert.deepEqual(await cancelled.json(),{cancelled:true});
    assert.equal((await realFetch(`${base}/${pending.flowId}`,{headers})).status,404);
  } finally { globalThis.fetch=realFetch; await new Promise(r=>server.close(r)); closeDatabase(); }
});
