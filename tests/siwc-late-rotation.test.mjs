import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';
import { requestWork } from '../src/request-work.ts';

const credential = {issuer:'https://auth.openai.com',subject:'synthetic-sub',clientId:'synthetic-client',accessToken:'synthetic-old-access',refreshToken:'synthetic-old-refresh',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access'],savedAt:'2026-01-01T00:00:00.000Z'};
const vault = { encrypt: x => x, decrypt: x => x };
const setup = () => { const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential); return {db,store}; };
const reply = (expires_in = 3600) => ({access_token:'synthetic-new-access',refresh_token:'synthetic-new-refresh',token_type:'Bearer',expires_in});
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return {promise,release}; };
const flush = async () => { for (let i=0;i<12;i++) await new Promise(r => setImmediate(r)); };
// Late work (e.g. jose's RS256 verification) can complete on the libuv threadpool, so a fixed number
// of event-loop turns is not enough under load. Wait until the refresh's tracked work has finished.
// The fake clock replaces Date.now/setTimeout, so the bound uses performance.now and setImmediate.
const settled = async (limitMs = 5000) => {
  const start = performance.now();
  while (requestWork['active'] !== 0) {
    if (performance.now() - start > limitMs) throw new Error('late refresh work did not finish');
    await new Promise(r => setImmediate(r));
  }
  await flush();
};
function clock() {
  const original = {now:Date.now, set:globalThis.setTimeout, clear:globalThis.clearTimeout};
  let now = original.now(), id = 0; const timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = (fn, ms=0) => { const n=++id; timers.set(n,{at:now+ms,fn}); return n; };
  globalThis.clearTimeout = n => timers.delete(n);
  return { advance(ms) { const target=now+ms; for (;;) { const next=[...timers].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0]; if (!next) break; now=next[1].at; timers.delete(next[0]); next[1].fn(); } now=target; }, restore() { Date.now=original.now; globalThis.setTimeout=original.set; globalThis.clearTimeout=original.clear; } };
}

test('positive control persists an on-time rotation', async () => {
  const {db,store}=setup();
  try { const c=await refreshSiwc(store,'a',store.readSnapshot('a'),async()=>Response.json(reply())); assert.equal(c.refreshToken==='synthetic-new-refresh',true); }
  finally { db.close(); }
});

test('late replies preserve logout and replacement fences, and malformed replies never resolve the claim', async () => {
  for (const mode of ['logout','replace','malformed']) {
    const {db,store}=setup(), fake=clock(), transport=gate(), entered=gate();
    try {
      const before=store.readSnapshot('a'); let calls=0, transportSignal;
      const pending=refreshSiwc(store,'a',before,async (_url,opts)=>{ calls++; transportSignal=opts.signal; entered.release(); return transport.promise; },30000);
      const outcome=pending.then(()=>false,e=>!String(e).includes('synthetic-') && /uncertain/.test(String(e)));
      await entered.promise; fake.advance(15000); await flush(); assert.equal(await outcome,true); assert.equal(transportSignal.aborted,true);
      if (mode==='logout') store.logout('a');
      if (mode==='replace') store.replace('a',{...credential,accessToken:'synthetic-admin-access',refreshToken:'synthetic-admin-refresh'});
      transport.release(Response.json(mode==='malformed' ? {...reply(),refresh_token:''} : reply())); await flush();
      assert.equal(calls,1);
      assert.equal(db.prepare('SELECT count(*) n FROM siwc_resolved_refresh_intents').get().n,0);
      if (mode==='logout') assert.equal(store.read('a'),null);
      if (mode==='replace') assert.equal(store.read('a').refreshToken==='synthetic-admin-refresh',true);
      if (mode==='malformed') assert.equal(store.read('a').refreshToken==='synthetic-old-refresh',true);
      assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents').get().n,1);
    } finally { transport.release(Response.json(reply())); await flush(); fake.restore(); db.close(); }
  }
});

test('late already-expired access rotation is saved without reporting success', async () => {
  const {db,store}=setup(), fake=clock(), transport=gate(), entered=gate();
  try {
    const pending=refreshSiwc(store,'a',store.readSnapshot('a'),async()=>{ entered.release(); return transport.promise; },30000);
    const outcome=pending.then(()=>false,e=>!String(e).includes('synthetic-') && /uncertain/.test(String(e)));
    await entered.promise; fake.advance(15000); await flush(); assert.equal(await outcome,true);
    transport.release(Response.json(reply(1))); await flush();
    assert.equal(store.read('a').refreshToken==='synthetic-new-refresh',true);
    assert.equal(db.prepare('SELECT count(*) n FROM siwc_resolved_refresh_intents').get().n,1);
  } finally { transport.release(Response.json(reply(1))); await flush(); fake.restore(); db.close(); }
});

test('late signed ID token uses fresh JWKS signal and rejects unverified identity', async () => {
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  for (const subject of ['synthetic-sub','different-sub']) {
    const {db,store}=setup(), fake=clock(), transport=gate(), entered=gate();
    try {
      const now=Math.floor(Date.now()/1000);
      const payload=`${encode({alg:'RS256',kid:'k'})}.${encode({iss:credential.issuer,aud:credential.clientId,sub:subject,iat:now,exp:now+300})}`;
      const idToken=`${payload}.${sign('RSA-SHA256',Buffer.from(payload),privateKey).toString('base64url')}`;
      let fresh=false, calls=0;
      const pending=refreshSiwc(store,'a',store.readSnapshot('a'),async (url,opts)=>{
        calls++;
        if (url.endsWith('jwks.json')) { fresh=!opts.signal.aborted; return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'k',alg:'RS256',use:'sig'}]}); }
        entered.release(); return transport.promise;
      },30000);
      const outcome=pending.then(()=>false,e=>!String(e).includes('synthetic-') && /uncertain/.test(String(e)));
      await entered.promise; fake.advance(15000); await flush(); assert.equal(await outcome,true);
      transport.release(Response.json({...reply(),id_token:idToken})); await settled();
      assert.equal(fresh,true); assert.equal(calls,2);
      assert.equal(store.read('a').refreshToken === (subject==='synthetic-sub' ? 'synthetic-new-refresh' : 'synthetic-old-refresh'),true);
      assert.equal(db.prepare('SELECT count(*) n FROM siwc_resolved_refresh_intents').get().n,subject==='synthetic-sub' ? 1 : 0);
    } finally { transport.release(Response.json(reply())); await flush(); fake.restore(); db.close(); }
  }
});

test('late persistence failure retains the permanent claim', async () => {
  const {db,store}=setup(), fake=clock(), transport=gate(), entered=gate();
  try {
    store.finishRefresh=()=>{ throw new Error('synthetic-db-secret'); };
    const pending=refreshSiwc(store,'a',store.readSnapshot('a'),async()=>{ entered.release(); return transport.promise; },30000);
    const outcome=pending.then(()=>false,e=>!String(e).includes('synthetic-') && /uncertain/.test(String(e)));
    await entered.promise; fake.advance(15000); await flush(); assert.equal(await outcome,true);
    transport.release(Response.json(reply())); await flush();
    assert.equal(store.read('a').refreshToken==='synthetic-old-refresh',true);
    assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM siwc_resolved_refresh_intents').get().n,0);
    assert.throws(()=>store.claimRefresh('a',store.readSnapshot('a')),/attempted/);
  } finally { transport.release(Response.json(reply())); await flush(); fake.restore(); db.close(); }
});

test('simulated lost commit acknowledgement never reports success or replays old token', async () => {
  const {db,store}=setup();
  try {
    const original=store.finishRefresh.bind(store);
    store.finishRefresh=(...args)=>{ original(...args); throw new Error('synthetic-commit-secret'); };
    const before=store.readSnapshot('a');
    const result=await refreshSiwc(store,'a',before,async()=>Response.json(reply())).then(()=>false,e=>!String(e).includes('synthetic-') && /uncertain/.test(String(e)));
    assert.equal(result,true);
    assert.equal(store.read('a').refreshToken==='synthetic-new-refresh',true);
    assert.equal(db.prepare('SELECT count(*) n FROM siwc_resolved_refresh_intents').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents').get().n,1);
    let calls=0;
    const observed=await refreshSiwc(store,'a',before,async()=>{ calls++; throw new Error('unexpected'); },500);
    assert.equal(calls,0); assert.equal(observed.refreshToken==='synthetic-new-refresh',true);
  } finally { db.close(); }
});

test('late body after operation deadline persists and remains tracked until finished', async () => {
  const {db,store}=setup(), fake=clock(), body=gate(), entered=gate(); let signal, drained=false;
  try {
    const result=refreshSiwc(store,'a',store.readSnapshot('a'),async (_url,opts)=>{ signal=opts.signal; entered.release(); return {status:200,json:()=>body.promise}; },30000);
    const outcome=result.then(()=> 'success',e=> { assert.equal(String(e).includes('synthetic-'),false); return 'uncertain'; });
    await entered.promise; fake.advance(14999); await flush(); assert.equal(signal.aborted,false);
    fake.advance(1); await flush();
    assert.equal(signal.aborted,true); assert.equal(await outcome,'uncertain');
    const drain=requestWork.stopAndDrain().then(()=>{drained=true;}); await flush(); assert.equal(drained,false);
    body.release(reply()); await flush(); await drain;
    assert.equal(store.read('a').refreshToken==='synthetic-new-refresh',true);
    assert.equal(db.prepare('SELECT count(*) n FROM siwc_resolved_refresh_intents').get().n,1);
  } finally { body.release(reply()); await flush(); fake.restore(); db.close(); }
});
