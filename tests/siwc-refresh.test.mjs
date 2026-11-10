import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';

const vault = { encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v, 'base64').toString() };
const credential = {issuer:'https://auth.openai.com',subject:'subject',clientId:'issued',accessToken:'old-access',refreshToken:'old-refresh',idToken:'old-id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access','chatgpt.tokens.use.direct'],savedAt:'2026-01-01T00:00:00.000Z'};
const setup = () => { const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential); return {db,store}; };

test('refresh posts issued registration and atomically persists rotated credentials', async () => {
  const {db,store} = setup();
  const next = await refreshSiwc(store,'a',store.readSnapshot('a'),async (url,opts) => {
    assert.equal(url,'https://auth.openai.com/api/accounts/oauth/token');
    assert.deepEqual(Object.fromEntries(opts.body),{grant_type:'refresh_token',client_id:'issued',refresh_token:'old-refresh',resource:'https://api.openai.com/v1'});
    return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600});
  });
  assert.equal(next.refreshToken,'new-refresh');
  assert.deepEqual(store.read('a'),next);
  assert.equal(next.idToken,'old-id');
  db.close();
});

test('terminal response after a waiter timeout still invalidates the claimed generation', async () => {
  const {db,store} = setup();
  let release;
  const late = new Promise(resolve => { release = resolve; });
  await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => late,10), /uncertain/);
  release(Response.json({error:'invalid_grant'},{status:400}));
  await new Promise(resolve => setTimeout(resolve,20));
  assert.equal(store.read('a'),null);
  assert.throws(() => store.replace('a',credential), /already attempted/);
  db.close();
});

test('terminal invalid grant clears only the claimed credentials and retains registration', async () => {
  const {db,store} = setup();
  await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => Response.json({error:'invalid_grant'},{status:400})), /reauthorization/);
  assert.equal(store.read('a'),null);
  store.replace('a',{...credential,refreshToken:'new-signin'});
  assert.equal(store.read('a').refreshToken,'new-signin');
  db.close();
});

test('stale terminal errors and successes cannot overwrite replacement', async () => {
  for (const reply of [Response.json({error:'invalid_grant'},{status:400}),Response.json({access_token:'rotated',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600})]) {
    const {db,store} = setup();
    await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => { store.replace('a',{...credential,refreshToken:'admin-refresh',accessToken:'admin-access'}); return reply; }), /uncertain/);
    assert.equal(store.read('a').accessToken,'admin-access');
    db.close();
  }
});

test('transport failure and malformed provider success never replay the old refresh token', async () => {
  for (const reply of [async () => { throw Error('network secret'); }, async () => Response.json({access_token:'new',token_type:'Bearer',expires_in:3600})]) {
    const {db,store} = setup();
    await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),reply), e => /uncertain/.test(e.message) && !e.message.includes('network secret'));
    let calls = 0;
    await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => { calls++; throw Error(); }), /attempted|uncertain/);
    assert.equal(calls,0);
    assert.deepEqual(store.read('a'),credential);
    db.close();
  }
});

test('returned ID tokens require matching signed identity', async () => {
  const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk = {...publicKey.export({format:'jwk'}),kid:'k',alg:'RS256',use:'sig'};
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  for (const subject of ['subject','other']) {
    const data = `${encode({alg:'RS256',kid:'k'})}.${encode({iss:credential.issuer,aud:credential.clientId,sub:subject,iat:now,exp:now+300})}`;
    const id = `${data}.${sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url')}`;
    const {db,store} = setup();
    const fetcher = async url => url.endsWith('jwks.json') ? Response.json({keys:[jwk]}) : Response.json({access_token:'new',refresh_token:'rotated',id_token:id,token_type:'Bearer',expires_in:3600});
    if (subject === 'subject') assert.equal((await refreshSiwc(store,'a',store.readSnapshot('a'),fetcher)).idToken,id);
    else { await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),fetcher),/uncertain/); assert.deepEqual(store.read('a'),credential); }
    db.close();
  }
});

test('malformed replacement refresh metadata fails closed after rotation attempt', async () => {
  for (const value of ['tomorrow', -1, 1.5, null]) {
    const {db,store} = setup();
    await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => Response.json({access_token:'new',refresh_token:'rotated',token_type:'Bearer',expires_in:3600,earliest_refresh_at:value})), /uncertain/);
    assert.deepEqual(store.read('a'),credential);
    assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_refresh_intents').get().n,1);
    db.close();
  }
});

test('past earliest refresh time permits a refresh', async () => {
  const db = new Database(':memory:');
  const store = new SiwcStore(db,vault);
  store.create('a',{...credential,earliestRefreshAt:Math.floor(Date.now()/1000)-1});
  const next = await refreshSiwc(store,'a',store.readSnapshot('a'),async () => Response.json({access_token:'new',refresh_token:'rotated',token_type:'Bearer',expires_in:3600}));
  assert.equal(next.refreshToken,'rotated');
  assert.equal(store.read('a').earliestRefreshAt,undefined);
  db.close();
});

test('rotated earliest refresh metadata survives storage and gates next refresh', async () => {
  const {db,store} = setup();
  const earliest = Math.floor(Date.now()/1000)+300;
  const next = await refreshSiwc(store,'a',store.readSnapshot('a'),async () => Response.json({access_token:'new',refresh_token:'rotated',token_type:'Bearer',expires_in:3600,earliest_refresh_at:earliest}));
  assert.equal(next.earliestRefreshAt,earliest);
  assert.equal(store.read('a').earliestRefreshAt,earliest);
  await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => { throw Error('must not send'); }), /too early/);
  db.close();
});

test('future earliest refresh metadata blocks a claim without burning the token', async () => {
  const db = new Database(':memory:');
  const store = new SiwcStore(db,vault);
  const pending = {...credential, earliestRefreshAt: Math.floor(Date.now()/1000)+300};
  store.create('a',pending);
  let sends = 0;
  await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => { sends++; throw Error('must not send'); }), /earliest|too early/i);
  assert.equal(sends,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_refresh_intents').get().n,0);
  db.close();
});

test('missing expected credential is rejected before claim or provider request', async () => {
  const {db,store} = setup();
  let sends = 0;
  await assert.rejects(refreshSiwc(store,'a',undefined,async () => { sends++; throw Error('must not send'); }), /expected|snapshot/i);
  assert.equal(sends,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_refresh_intents').get().n,0);
  db.close();
});

test('stale caller cannot refresh an administratively replaced credential', async () => {
  const {db,store} = setup();
  const snapshot = store.readSnapshot('a');
  store.replace('a',{...credential,accessToken:'admin-access',refreshToken:'admin-refresh'});
  let sends = 0;
  await assert.rejects(refreshSiwc(store,'a',snapshot,async () => { sends++; throw Error('must not send'); }), /changed/);
  assert.equal(sends,0);
  assert.equal(store.read('a').accessToken,'admin-access');
  db.close();
});

test('persists rotation but does not return an already expired access token', async () => {
  const {db,store} = setup();
  await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => {
    await new Promise(resolve => setTimeout(resolve,1100));
    return Response.json({access_token:'expired',refresh_token:'new-refresh',token_type:'Bearer',expires_in:1});
  }), /expired/);
  assert.equal(store.read('a').refreshToken,'new-refresh');
  db.close();
});

test('separate processes serialize and a crashed claimant never replays', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR,'siwc-refresh-'));
  const path = join(dir,'shared.sqlite');
  const db = new Database(path,{timeout:5000});
  const store = new SiwcStore(db,vault);
  const worker = (timeout = 30000) => fork(new URL('./siwc-refresh-worker.mjs',import.meta.url),[path,String(timeout)],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','inherit','ipc']});
  let a, b;
  try {
    store.create('a',credential);
    a = worker(); b = worker(200);
    await Promise.all([once(a,'message'),once(b,'message')]);
    const aSent = once(a,'message'); a.send('go'); assert.equal((await aSent)[0],'sent');
    const bResult = once(b,'message'); b.send('go'); assert.equal((await bResult)[0],'rejected');
    const bExit = once(b,'exit'); await bExit;
    const aExit = once(a,'exit'); a.kill(); await aExit;
    let sends = 0;
    await assert.rejects(refreshSiwc(store,'a',store.readSnapshot('a'),async () => { sends++; throw Error('must not send'); },100), /attempted|uncertain/);
    assert.equal(sends,0);
    assert.deepEqual(store.read('a'),credential);
  } finally { if (a?.connected) a.kill(); if (b?.connected) b.kill(); db.close(); rmSync(dir,{recursive:true,force:true}); }
});
