import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';
const vault = {encrypt:v=>Buffer.from(v).toString('base64'),decrypt:v=>Buffer.from(v,'base64').toString()};
const credential = {issuer:'https://auth.openai.com',subject:'subject',clientId:'issued',accessToken:'old-access',refreshToken:'old-refresh',idToken:'old-id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access'],savedAt:'2026-01-01T00:00:00.000Z'};
function spawn(file) {
  const child = fork(new URL('./siwc-refresh-process-worker.mjs',import.meta.url),[file],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','inherit','ipc']});
  const messages = []; const waiters = [];
  child.on('message', msg => { messages.push(msg); for (const resolve of waiters.splice(0)) resolve(); });
  const wait = async type => { while (!messages.some(m=>m.type===type)) { const error=messages.find(m=>m.type==='error'); if (error) throw Error(error.message); if (child.exitCode !== null || child.signalCode !== null) throw Error(`worker exited before ${type}`); await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(Error(`timeout: ${type}`)),10000); waiters.push(()=>{ clearTimeout(timer); resolve(); }); }); } return messages.find(m=>m.type===type); };
  return {child,messages,wait};
}
test('two processes wait for one provider request and both return its rotated credential', {timeout:20000}, async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'siwc-refresh-shared-')); const file=join(dir,'test.sqlite');
  const db=new Database(file,{timeout:5000}); let a,b;
  try {
    new SiwcStore(db,vault).create('a',credential);
    a=spawn(file); b=spawn(file); await Promise.all([a.wait('ready'),b.wait('ready')]);
    a.child.send('go'); await a.wait('provider');
    b.child.send('go'); await b.wait('waiting');
    a.child.send('release');
    const result=await Promise.all([a.wait('success'),b.wait('success')]);
    assert.equal([...a.messages,...b.messages].filter(m=>m.type==='provider').length,1);
    assert.deepEqual(result[0].value,result[1].value);
    assert.equal(result[1].value.accessToken,'rotated'); assert.equal(result[1].value.refreshToken,'rotated-refresh');
  } finally { await Promise.all([a,b].filter(Boolean).map(({child}) => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit',resolve); child.kill(); }))); db.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('stale generation cannot adopt a later refresh of the same token after replacement', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault);
  try {
    store.create('a',credential); const stale=store.readSnapshot('a');
    store.replace('a',credential);
    await refreshSiwc(store,'a',store.readSnapshot('a'),async()=>Response.json({access_token:'rotated',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600}),200);
    await assert.rejects(refreshSiwc(store,'a',stale,async()=>{ throw Error('unexpected provider call'); },200),/changed/);
  } finally { db.close(); }
});
test('resolved refresh cannot authorize a replaced identical result revision', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault);
  try {
    store.create('a',credential); const stale=store.readSnapshot('a');
    const rotated=await refreshSiwc(store,'a',stale,async()=>Response.json({access_token:'rotated',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600}),200);
    store.replace('a',rotated);
    await assert.rejects(refreshSiwc(store,'a',stale,async()=>{ throw Error('unexpected provider call'); },200),/changed/);
  } finally { db.close(); }
});
for (const scenario of ['timeout','abort','logout','reauthorize']) test(`unresolved cross-connection claim: ${scenario} fails closed without replay`, async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'siwc-refresh-wait-')); const file=join(dir,'db.sqlite');
  const db1=new Database(file), db2=new Database(file); const owner=new SiwcStore(db1,vault), waiter=new SiwcStore(db2,vault);
  const observe = SiwcStore.prototype.observeRefresh; let fenced = false;
  try {
    owner.create('a',credential); const snapshot=owner.readSnapshot('a'); const intent=owner.claimRefresh('a',snapshot);
    const controller=new AbortController(); let calls=0;
    let observed; const observedPending = new Promise(resolve => { observed = resolve; });
    if (scenario==='abort' || scenario==='logout' || scenario==='reauthorize') {
      // Fence only after the waiter has actually observed the unresolved claim.
      SiwcStore.prototype.observeRefresh = function (...args) {
        const state = observe.apply(this,args);
        if (!fenced && state.status==='pending') {
          fenced = true; observed();
          if (scenario !== 'abort') owner.logout('a');
          if (scenario==='reauthorize') owner.replace('a',{...credential,accessToken:'replacement',refreshToken:'replacement-refresh'});
        }
        return state;
      };
    }
    const pending=refreshSiwc(waiter,'a',snapshot,async()=>{calls++; throw Error('must not send');},scenario==='timeout'?120:5000,controller.signal);
    if (scenario==='abort') {
      // Abort only after observing the claim; always settle the waiter on failure.
      let timer;
      try {
        await Promise.race([observedPending, pending.then(() => { throw Error('waiter unexpectedly succeeded'); }), new Promise((_,reject) => { timer=setTimeout(()=>reject(Error('timeout waiting for pending claim')),4000); })]);
        controller.abort(new Error('cancelled'));
        await assert.rejects(pending,/cancelled/);
      } finally { clearTimeout(timer); controller.abort(new Error('cleanup')); await pending.catch(() => {}); }
    } else {
      await assert.rejects(pending,scenario==='timeout'?/uncertain/:/changed/);
    }
    if (scenario!=='timeout') assert.equal(fenced,true);
    assert.equal(calls,0); assert.equal(getEventListeners(controller.signal,'abort').length,0);
    if (scenario==='logout' || scenario==='reauthorize') assert.throws(()=>owner.finishRefresh('a',intent,{...credential,accessToken:'rotated',refreshToken:'rotated-refresh'}),/changed/);
    if (scenario==='timeout' || scenario==='abort') assert.deepEqual(owner.read('a'),credential);
    if (scenario==='logout') assert.equal(owner.read('a'),null);
    if (scenario==='reauthorize') assert.equal(owner.read('a').accessToken,'replacement');
    db2.close(); await new Promise(resolve=>setTimeout(resolve,70));
  } finally { SiwcStore.prototype.observeRefresh = observe; if (db2.open) db2.close(); db1.close(); rmSync(dir,{recursive:true,force:true}); }
});
