import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as ledger from '../src/db/durable-ledger-foundation.ts';

test('v1 upgrade preserves restriction and unrelated data', () => {
  const db = new Database(':memory:'); const p='phase4_experimental_ledger_';
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
      INSERT INTO ${p}version VALUES(1); INSERT INTO ${p}attempts VALUES('old','UNKNOWN_429',2);
      INSERT INTO ${p}restrictions VALUES('old','UNKNOWN_429'); CREATE TABLE unrelated(x); INSERT INTO unrelated VALUES(42);`);
    ledger.migrateLedger(db);
    assert.equal(db.prepare(`SELECT version FROM ${p}version`).get().version,2);
    assert.equal(db.prepare(`SELECT state FROM ${p}attempts`).get().state,'UNKNOWN_429');
    assert.equal(db.prepare(`SELECT source_id FROM ${p}restrictions`).get().source_id,'old');
    assert.equal(db.prepare('SELECT x FROM unrelated').get().x,42);
    assert.equal(ledger.openAttempt(db,'new'),false);
  } finally {db.close();}
});

test('two processes cannot start the same OPEN twice', {timeout:15000}, async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-race-')); const file=path.join(dir,'test.sqlite');
  const db=new Database(file); const children=[];
  try {
    ledger.migrateLedger(db); assert.equal(ledger.openAttempt(db,'race'),true);
    const worker=fileURLToPath(new URL('./phase4-ledger-coordinator-worker.mjs',import.meta.url));
    const outcomes=[];
    const run=()=>new Promise((resolve,reject)=>{
      const child=fork(worker,[file],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','pipe','ipc']}); children.push(child);
      child.on('message',m=>{outcomes.push(m); if(m==='ready' && outcomes.filter(x=>x==='ready').length===2) children.forEach(c=>c.send('go'));});
      child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error(`worker exit ${code}`)));
    });
    await Promise.all([run(),run()]);
    // Both contenders may fail closed on zero-timeout SQLite contention, even
    // after one durable claim. Safety requires at most one start, not progress.
    const starts=outcomes.filter(x=>x==='started').length;
    const claims=db.prepare('SELECT count(*) n FROM phase4_experimental_ledger_dispatch_claims').get().n;
    assert.ok(starts<=1);
    assert.ok(claims<=1);
    assert.ok(starts<=claims);
  } finally {children.forEach(c=>c.kill()); db.close(); rmSync(dir,{recursive:true,force:true});}
});

test('start throw or failed commit leaves permanent claim and OPEN', async () => {
  for (const mode of ['throw','commit']) {
    const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-failure-')); const file=path.join(dir,'test.sqlite');
    const db=new Database(file); const reader=new Database(file); let starts=0;
    try {
      ledger.migrateLedger(db); ledger.openAttempt(db,'x');
      await assert.rejects(ledger.dispatchOpenAttemptOnce(file,'x',()=>{
        if(mode==='commit') {reader.exec('BEGIN'); reader.prepare('SELECT * FROM phase4_experimental_ledger_attempts').all();}
      },()=>{starts++; if(mode==='throw') throw new Error('start failed'); return Promise.reject(new Error('provider failed'));}));
      if(reader.inTransaction) reader.exec('ROLLBACK');
      await assert.rejects(ledger.dispatchOpenAttemptOnce(file,'x',()=>{},()=>{starts++; return Promise.resolve();}));
      assert.equal(starts,1);
      assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts').get().state,'OPEN');
      assert.equal(db.prepare('SELECT count(*) n FROM phase4_experimental_ledger_dispatch_claims').get().n,1);
    } finally {if(reader.inTransaction) reader.exec('ROLLBACK'); reader.close(); db.close(); rmSync(dir,{recursive:true,force:true});}
  }
});

test('process death during start permanently consumes the claim', {timeout:15000}, async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-crash-')); const file=path.join(dir,'test.sqlite');
  const db=new Database(file); let child;
  try {
    ledger.migrateLedger(db); ledger.openAttempt(db,'race');
    const worker=fileURLToPath(new URL('./phase4-ledger-coordinator-worker.mjs',import.meta.url));
    const code=await new Promise((resolve,reject)=>{
      child=fork(worker,[file,'crash'],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','pipe','ipc']});
      child.on('message',m=>{if(m==='ready') child.send('go');}); child.on('error',reject); child.on('exit',resolve);
    });
    assert.equal(code,23);
    await assert.rejects(ledger.dispatchOpenAttemptOnce(file,'race',()=>{},()=>Promise.resolve()));
    assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts').get().state,'OPEN');
    assert.equal(ledger.finishAttempt(db,'race',1,'SUCCESS'),'conflict');
    assert.equal(ledger.openAttempt(db,'after-crash'),false);
  } finally {child?.kill(); db.close(); rmSync(dir,{recursive:true,force:true});}
});

test('client cancellation after initiation cannot cause replay', async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-cancel-')); const file=path.join(dir,'test.sqlite');
  const db=new Database(file); let starts=0; let cancel;
  try {
    ledger.migrateLedger(db); ledger.openAttempt(db,'x');
    const request=ledger.dispatchOpenAttemptOnce(file,'x',()=>{},()=>{starts++; return new Promise((_,reject)=>{cancel=reject;});});
    cancel(new Error('cancelled'));
    await assert.rejects(request,/cancelled/);
    await assert.rejects(ledger.dispatchOpenAttemptOnce(file,'x',()=>{},()=>{starts++; return Promise.resolve();}));
    assert.equal(starts,1);
  } finally {db.close(); rmSync(dir,{recursive:true,force:true});}
});

test('coordinator rejects an active transaction on the supplied connection', async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-nested-')); const file=path.join(dir,'test.sqlite');
  const db=new Database(file);
  try {
    ledger.migrateLedger(db); ledger.openAttempt(db,'x'); db.exec('BEGIN');
    await assert.rejects(ledger.dispatchOpenAttemptOnce(db,'x',()=>{},()=>Promise.resolve()),/no active transaction/);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) n FROM phase4_experimental_ledger_dispatch_claims').get().n,0);
  } finally {if(db.inTransaction) db.exec('ROLLBACK'); db.close(); rmSync(dir,{recursive:true,force:true});}
});
