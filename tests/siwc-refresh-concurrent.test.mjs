import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';

const vault = { encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v,'base64').toString() };
const credential = { issuer:'https://auth.openai.com', subject:'subject', clientId:'issued', accessToken:'old-access', refreshToken:'old-refresh', idToken:'old-id', tokenType:'Bearer', expiresIn:3600, scopes:['offline_access','chatgpt.tokens.use.direct'], savedAt:'2026-01-01T00:00:00.000Z' };

test('concurrent requests for the same snapshot share one rotation', async () => {
  const db = new Database(':memory:');
  const firstStore = new SiwcStore(db,vault), secondStore = new SiwcStore(db,vault);
  firstStore.create('a',credential);
  const snapshot = firstStore.readSnapshot('a');
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async () => { calls++; await gate; return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600}); };
  try {
    const first = refreshSiwc(firstStore,'a',snapshot,fetcher);
    const second = refreshSiwc(secondStore,'a',snapshot,fetcher);
    release();
    const [a,b] = await Promise.all([first,second]);
    assert.equal(calls,1);
    assert.equal(a.accessToken,'new-access');
    assert.deepEqual(b,a);
  } finally { db.close(); }
});

test('logout during shared refresh fences every waiter and cannot restore credentials', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential);
  let release, started, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const fetcher = async () => { calls++; started(); await gate; return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600}); };
  const snapshot = store.readSnapshot('a');
  try {
    const a = refreshSiwc(store,'a',snapshot,fetcher);
    const b = refreshSiwc(store,'a',snapshot,fetcher);
    await entered; store.logout('a'); release();
    const results = await Promise.allSettled([a,b]);
    assert.deepEqual(results.map(r => r.status),['rejected','rejected']);
    assert.equal(calls,1); assert.equal(store.read('a'),null);
  } finally { db.close(); }
});

test('identical replacement after refresh completion is not the completed revision', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential);
  const snapshot = store.readSnapshot('a');
  const finish = store.finishRefresh.bind(store);
  store.finishRefresh = (...args) => { const result = finish(...args); store.replace('a',store.read('a')); return result; };
  try {
    await assert.rejects(refreshSiwc(store,'a',snapshot,async()=>Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600}),200),/changed/);
  } finally { db.close(); }
});

test('short first waiter cannot shorten a later waiter deadline', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential);
  const snapshot = store.readSnapshot('a'); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async () => { await gate; return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600}); };
  try {
    const first = refreshSiwc(store,'a',snapshot,fetcher,30);
    const later = refreshSiwc(store,'a',snapshot,fetcher,500);
    const firstResult = first.then(()=> 'resolved',()=> 'rejected');
    const laterResult = later.then(value=>value.accessToken,()=> 'rejected');
    assert.equal(await firstResult,'rejected');
    release(); assert.equal(await laterResult,'new-access');
  } finally { release(); await new Promise(r=>setTimeout(r,20)); db.close(); }
});

test('each shared refresh waiter has its own deadline', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential);
  const snapshot = store.readSnapshot('a'); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetcher = async () => { await gate; return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600}); };
  try {
    const owner = refreshSiwc(store,'a',snapshot,fetcher,1000);
    const short = refreshSiwc(store,'a',snapshot,fetcher,30);
    const result = await Promise.race([short.then(()=> 'resolved',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('hung'),180))]);
    assert.equal(result,'rejected');
    release(); assert.equal((await owner).accessToken,'new-access');
  } finally { release(); await new Promise(r=>setTimeout(r,20)); db.close(); }
});

test('aborting the initiating waiter does not cancel the shared exchange', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential);
  const snapshot = store.readSnapshot('a'); let release, started, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const fetcher = async (_url, opts) => { calls++; started(); await gate; assert.equal(opts.signal.aborted,false); return Response.json({access_token:'new-access',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600}); };
  const controller = new AbortController();
  try {
    const first = refreshSiwc(store,'a',snapshot,fetcher,500,controller.signal);
    const second = refreshSiwc(store,'a',snapshot,fetcher,500);
    await entered; controller.abort(new Error('cancelled'));
    await assert.rejects(first,/cancelled/); release();
    assert.equal((await second).accessToken,'new-access'); assert.equal(calls,1);
  } finally { release(); db.close(); }
});
