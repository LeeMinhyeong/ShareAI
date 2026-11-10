import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {migrateLedger, openAttempt, finishAttempt} from '../src/db/durable-ledger-foundation.ts';

const worker = new URL('./phase4-ledger-foundation-worker.mjs', import.meta.url);
const args = ['--import', import.meta.resolve('tsx'), fileURLToPath(worker)];
function run(file, action, id) {
  const p = spawnSync(process.execPath, [...args, file, action, id], {encoding:'utf8', timeout:10000});
  assert.equal(p.status, 0, p.stderr); return p.stdout.trim();
}
function fixture(fn) {
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-foundation-'));
  const file=path.join(dir,'ledger.sqlite'); const db=new Database(file,{timeout:0});
  try { migrateLedger(db); return fn(db,file); }
  finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
}

test('committed OPEN survives process death and fences another process globally', async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-crash-'));
  const file=path.join(dir,'ledger.sqlite'); const db=new Database(file,{timeout:0}); migrateLedger(db); db.close();
  const child=spawn(process.execPath,[...args,file,'hold','attempt-one'],{stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(new Error('worker timeout')),10000); child.stdout.once('data',d=>{clearTimeout(timer); assert.match(String(d),/OPEN/);resolve();}); child.once('error',reject); child.once('exit',code=>{clearTimeout(timer);reject(new Error(`early exit ${code}`));}); });
    child.kill(); await new Promise(resolve=>child.once('exit',resolve));
    assert.equal(run(file,'open','attempt-two'),'BLOCKED');
  } finally { if(child.exitCode===null && child.signalCode===null) child.kill(); rmSync(dir,{recursive:true,force:true}); }
});

test('success permits a new attempt and unknown 429 survives reopen',()=>fixture((db,file)=>{
  assert.equal(openAttempt(db,'first'),true);
  assert.equal(finishAttempt(db,'first',1,'SUCCESS'),'finished');
  assert.equal(run(file,'open','second'),'OPEN');
  assert.equal(finishAttempt(db,'second',1,'UNKNOWN_429'),'finished');
  assert.equal(run(file,'open','third'),'BLOCKED');
  assert.equal(finishAttempt(db,'first',1,'SUCCESS'),'duplicate');
  assert.equal(run(file,'open','fourth'),'BLOCKED');
}));

test('finish is compare-and-set and conflicting outcomes cannot mutate a fence',()=>fixture((db)=>{
  assert.equal(openAttempt(db,'a'),true);
  assert.equal(finishAttempt(db,'a',2,'SUCCESS'),'conflict');
  assert.equal(openAttempt(db,'b'),false);
  assert.equal(finishAttempt(db,'a',1,'UNKNOWN_429'),'finished');
  assert.equal(finishAttempt(db,'a',1,'UNKNOWN_429'),'duplicate');
  assert.equal(finishAttempt(db,'a',1,'SUCCESS'),'conflict');
  assert.equal(openAttempt(db,'c'),false);
}));

test('migration refuses an outer transaction before creating schema',()=>{
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-nested-migration-'));
  const file=path.join(dir,'ledger.sqlite'); const db=new Database(file);
  try {
    db.pragma('busy_timeout = 4321');
    db.exec('BEGIN');
    assert.throws(()=>migrateLedger(db), /ledger.*active transaction/i);
    assert.equal(db.pragma('busy_timeout',{simple:true}),4321);
    db.exec('COMMIT');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'phase4_experimental_ledger_%'").get().n,0);
    migrateLedger(db);
    assert.equal(run(file,'open','after-migration'),'OPEN');
  } finally { if(db.inTransaction) db.exec('ROLLBACK'); db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('committed APIs reject caller transactions and leave no phantom claim or restriction',()=>fixture((db,file)=>{
  const error = /ledger.*active transaction/i;
  db.exec('BEGIN');
  try {
    assert.throws(()=>migrateLedger(db), error);
    assert.throws(()=>openAttempt(db,'nested'), error);
    assert.equal(db.inTransaction,true);
  } finally { db.exec('ROLLBACK'); }
  assert.equal(db.prepare('SELECT count(*) AS n FROM phase4_experimental_ledger_attempts').get().n,0);
  assert.equal(run(file,'open','standalone'),'OPEN');

  db.exec('BEGIN');
  db.exec('SAVEPOINT caller_nested');
  try {
    assert.throws(()=>finishAttempt(db,'standalone',1,'UNKNOWN_429'), error);
    assert.equal(db.inTransaction,true);
  } finally { db.exec('ROLLBACK'); }
  assert.deepEqual(db.prepare('SELECT state,revision FROM phase4_experimental_ledger_attempts WHERE id=?').get('standalone'),{state:'OPEN',revision:1});
  assert.equal(db.prepare('SELECT count(*) AS n FROM phase4_experimental_ledger_restrictions').get().n,0);
  assert.equal(run(file,'open','competitor'),'BLOCKED');
  assert.equal(finishAttempt(db,'standalone',1,'UNKNOWN_429'),'finished');
  assert.equal(run(file,'open','after-unknown'),'BLOCKED');
}));

test('writer contention fails closed without waiting',()=>fixture((db,file)=>{
  const other=new Database(file,{timeout:0});
  try { db.exec('BEGIN IMMEDIATE'); assert.throws(()=>openAttempt(other,'blocked'), /locked|busy/i); db.exec('ROLLBACK'); }
  finally { if(db.inTransaction) db.exec('ROLLBACK'); other.close(); }
}));
