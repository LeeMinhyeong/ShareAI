import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';
const vault={encrypt:v=>Buffer.from(v).toString('base64'),decrypt:v=>Buffer.from(v,'base64').toString()};
const credential={issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'old',refreshToken:'old-refresh',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access'],savedAt:'2020-01-01T00:00:00.000Z'};
test('cross-process sqlite write contention yields to cancellation without invoking provider', {timeout:5000}, async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR,'siwc-lock-')); const file=join(dir,'db.sqlite');
  const db=new Database(file,{timeout:2000}); const store=new SiwcStore(db,vault); store.create('a',credential); const snapshot=store.readSnapshot('a');
  const child=fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
  try {
    await new Promise((resolve,reject)=>{child.once('message',resolve); child.once('error',reject);});
    const controller=new AbortController(); let calls=0; let timerRan=false;
    setTimeout(()=>{timerRan=true; controller.abort(new Error('cancelled'));},30);
    const start=Date.now();
    const result=await refreshSiwc(store,'a',snapshot,async()=>{calls++; return Response.json({access_token:'new',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600});},80,controller.signal).then(()=> 'resolved',()=> 'rejected');
    const elapsed=Date.now()-start;
    assert.equal(result,'rejected'); assert.equal(timerRan,true); assert.ok(elapsed<300,`blocked ${elapsed}ms`); assert.equal(calls,0);
    assert.equal(db.pragma('busy_timeout', {simple:true}),2000);
    await new Promise(r=>setTimeout(r,120)); assert.equal(calls,0);
  } finally { if (child.exitCode===null && child.signalCode===null) { child.kill(); await new Promise(r=>child.once('exit',r)); } db.close(); rmSync(dir,{recursive:true,force:true}); }
});
