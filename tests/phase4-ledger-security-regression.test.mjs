import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as ledger from '../src/db/durable-ledger-foundation.ts';

const p='phase4_experimental_ledger_';
test('unguarded dispatch fence is not a public API',()=>{
  assert.equal('createOpenAttemptDispatchFence' in ledger,false);
});
test('v1 OPEN migration fails atomically without changing data or schema',()=>{
  const db=new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ${p}version (version INTEGER NOT NULL CHECK(version=1));
      CREATE TABLE ${p}attempts (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('OPEN','SUCCESS','UNKNOWN_429')),
        revision INTEGER NOT NULL CHECK(revision IN (1,2))
      );
      CREATE TABLE ${p}restrictions (
        source_id TEXT PRIMARY KEY NOT NULL REFERENCES ${p}attempts(id),
        reason TEXT NOT NULL CHECK(reason='UNKNOWN_429')
      );
      INSERT INTO ${p}version VALUES(1); INSERT INTO ${p}attempts VALUES('old','OPEN',1);
      CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES(42);`);
    const before=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    assert.throws(()=>ledger.migrateLedger(db),/OPEN/);
    assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),before);
    assert.deepEqual(db.prepare(`SELECT * FROM ${p}attempts`).all(),[{id:'old',state:'OPEN',revision:1}]);
    assert.equal(db.prepare(`SELECT version FROM ${p}version`).get().version,1);
    assert.equal(db.prepare('SELECT x FROM unrelated').get().x,42);
  } finally {db.close();}
});
test('another process cannot finish a claimed OPEN while work is pending', {timeout:15000}, async()=>{
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-security-')); const file=path.join(dir,'test.sqlite');
  const db=new Database(file); let child;
  try {
    ledger.migrateLedger(db); assert.equal(ledger.openAttempt(db,'race'),true);
    const worker=fileURLToPath(new URL('./phase4-ledger-security-worker.mjs',import.meta.url));
    child=fork(worker,[file],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','pipe','ipc']});
    const events=[]; let notify;
    child.on('message',m=>{events.push(m); notify?.();});
    const wait=async value=>{while(!events.includes(value)){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`timeout waiting ${value}: ${events}`)),4000); notify=()=>{clearTimeout(timer);resolve();};});}};
    await wait('started');
    assert.equal(ledger.finishAttempt(db,'race',1,'SUCCESS'),'conflict');
    assert.equal(ledger.openAttempt(db,'premature'),false);
    child.send('release'); await wait('done');
    assert.equal(db.prepare(`SELECT state FROM ${p}attempts WHERE id='race'`).get().state,'SUCCESS');
    assert.equal(ledger.openAttempt(db,'next'),true);
  } finally {child?.kill(); db.close(); rmSync(dir,{recursive:true,force:true});}
});
test('failed, unclassified and 429 results remain fenced after settlement and reopen', async()=>{
  for (const mode of ['rejected','unclassified','429','classifier-error']) {
    const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-result-')); const file=path.join(dir,'test.sqlite');
    let db=new Database(file);
    try {
      ledger.migrateLedger(db); ledger.openAttempt(db,'x');
      const request=ledger.dispatchOpenAttemptOnce(file,'x',()=>{},()=>mode==='rejected' ? Promise.reject(new Error('network')) : Promise.resolve(mode), result=>{
        if (result==='classifier-error') throw new Error('classifier');
        return result==='429' ? 'UNKNOWN_429' : undefined;
      });
      if (mode==='rejected' || mode==='classifier-error') await assert.rejects(request);
      else assert.equal(await request,mode);
      db.close(); db=new Database(file);
      assert.equal(ledger.finishAttempt(db,'x',1,'SUCCESS'),'conflict');
      assert.equal(ledger.openAttempt(db,'new'),false);
      assert.equal(db.prepare(`SELECT state FROM ${p}attempts WHERE id='x'`).get().state,mode==='429'?'UNKNOWN_429':'OPEN');
      await assert.rejects(ledger.dispatchOpenAttemptOnce(file,'x',()=>{},()=>Promise.resolve('replay')));
    } finally {db.close();rmSync(dir,{recursive:true,force:true});}
  }
});
