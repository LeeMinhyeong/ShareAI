import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {migrateLedger, openAttempt, finishAttempt} from '../src/db/durable-ledger-foundation.ts';
const recovery = await import('../src/db/experimental-recovery-evidence.ts').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});

const actor='123e4567-e89b-42d3-a456-426614174000';
test('records only matching OPEN snapshot as evidence without resolving it',()=>{
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'recovery-evidence-'));
  const db=new Database(path.join(dir,'test.sqlite'));
  try {
    migrateLedger(db); openAttempt(db,'a');
    assert.equal(typeof recovery.prepareEvidence, 'function');
    recovery.migrateEvidence(db);
    assert.equal(recovery.prepareEvidence(db,{attemptId:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}),true);
    assert.equal(openAttempt(db,'b'),false);
    assert.deepEqual(db.prepare('SELECT attempt_id, revision, actor, reason FROM phase4_experimental_recovery_evidence').all(),[{attempt_id:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}]);
    assert.equal(finishAttempt(db,'a',1,'SUCCESS'),'finished');
    assert.equal(recovery.prepareEvidence(db,{attemptId:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}),false);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('audit is append-only and rejects unstructured reasons and caller transactions',()=>{
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'evidence-audit-')); const db=new Database(path.join(dir,'db.sqlite'));
  try {
    migrateLedger(db); recovery.migrateEvidence(db); openAttempt(db,'a');
    const input={attemptId:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'};
    assert.throws(()=>recovery.prepareEvidence(db,{...input,reason:'secret free text'}),/Invalid evidence/);
    db.exec('BEGIN');
    assert.throws(()=>recovery.prepareEvidence(db,input),/active transaction/);
    db.exec('ROLLBACK');
    assert.equal(recovery.prepareEvidence(db,input),true);
    for(const sql of ["UPDATE phase4_experimental_recovery_evidence SET actor='other'",'DELETE FROM phase4_experimental_recovery_evidence',"INSERT OR REPLACE INTO phase4_experimental_recovery_evidence VALUES(1,'a',1,'x','INVESTIGATE_OPEN')"]) assert.throws(()=>db.exec(sql),/append only/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM phase4_experimental_recovery_evidence').get().n,1);
  } finally { if(db.inTransaction) db.exec('ROLLBACK'); db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('migration and writes fail closed on schema tampering without partial audit',()=>{
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'evidence-tamper-')); const db=new Database(path.join(dir,'db.sqlite'));
  try {
    migrateLedger(db); openAttempt(db,'a');
    db.exec('CREATE TABLE phase4_experimental_recovery_intruder (x INTEGER)');
    assert.throws(()=>recovery.migrateEvidence(db),/Unsupported evidence schema/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='phase4_experimental_recovery_evidence'").get().n,0);
    db.exec('DROP TABLE phase4_experimental_recovery_intruder'); recovery.migrateEvidence(db);
    db.exec('DROP TRIGGER phase4_experimental_recovery_no_update');
    assert.throws(()=>recovery.prepareEvidence(db,{attemptId:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}),/Unsupported evidence schema/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM phase4_experimental_recovery_evidence').get().n,0);
    assert.equal(openAttempt(db,'b'),false);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('rejects TEMP ledger shadow even when main ledger exists',()=>{
  const db=new Database(':memory:');
  try {
    migrateLedger(db); recovery.migrateEvidence(db);
    db.exec("CREATE TEMP TABLE phase4_experimental_ledger_attempts(id TEXT,state TEXT,revision INTEGER); INSERT INTO temp.phase4_experimental_ledger_attempts VALUES('a','OPEN',1)");
    assert.throws(()=>recovery.prepareEvidence(db,{attemptId:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}),/Unsupported ledger schema/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.phase4_experimental_recovery_evidence').get().n,0);
  } finally { db.close(); }
});

test('rejects bogus ledger schema and corrupt ledger state',()=>{
  for (const corruption of [
    db=>db.exec('ALTER TABLE phase4_experimental_ledger_attempts ADD COLUMN bogus TEXT'),
    db=>db.exec("PRAGMA ignore_check_constraints=ON; UPDATE phase4_experimental_ledger_attempts SET revision=2; PRAGMA ignore_check_constraints=OFF")
  ]) {
    const db=new Database(':memory:');
    try {
      migrateLedger(db); recovery.migrateEvidence(db); openAttempt(db,'a'); corruption(db);
      assert.throws(()=>recovery.prepareEvidence(db,{attemptId:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}),/Unsupported ledger schema|Invalid ledger data/);
      assert.equal(db.prepare('SELECT count(*) AS n FROM main.phase4_experimental_recovery_evidence').get().n,0);
    } finally { db.close(); }
  }
});

for(const first of ['evidence','finish']) test(`cross-process ${first}-first holds writer until competing operation is blocked`,async()=>{
  const dir=mkdtempSync(path.join(process.env.TMPDIR,'evidence-race-')); const file=path.join(dir,'db.sqlite'); const release=path.join(dir,'release');
  const db=new Database(file,{timeout:0}); const children=[];
  try {
    migrateLedger(db); recovery.migrateEvidence(db); openAttempt(db,'a');
    const worker=fileURLToPath(new URL('./phase4-recovery-evidence-worker.mjs',import.meta.url));
    function launch(action,role) {
      const child=fork(worker,[file,action,role,release],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','pipe','ipc']}); children.push(child);
      let stderr=''; child.stderr.on('data',d=>stderr+=d);
      const events=new Map(); let failure;
      child.on('message',m=>{ const e=events.get(m.event); if(e) e.resolve(m); else events.set(m.event,{value:m}); });
      child.on('error',e=>{failure=e; for(const x of events.values()) x.reject?.(e);});
      child.on('exit',code=>{if(code!==0) { failure=new Error(`worker ${code}: ${stderr}`); for(const x of events.values()) x.reject?.(failure); }});
      return {child, wait(event) {
        if(failure) return Promise.reject(failure);
        if(events.has(event)) return Promise.resolve(events.get(event).value);
        return new Promise((resolve,reject)=>events.set(event,{resolve,reject}));
      }};
    }
    const a=launch(first,'first'), b=launch(first==='evidence'?'finish':'evidence','second');
    const run=async()=>{
      await Promise.all([a.wait('ready'),b.wait('ready')]);
      a.child.send('go'); const held=await a.wait('held');
      assert.deepEqual(held.state,first==='evidence'?{state:'OPEN',revision:1}:{state:'UNKNOWN_429',revision:2});
      assert.equal(held.count,first==='evidence'?1:0);
      b.child.send('go'); await b.wait('busy');
      writeFileSync(release,'release');
      const [ar,br]=await Promise.all([a.wait('result'),b.wait('result')]);
      assert.equal(ar.result,first==='evidence'?true:'finished');
      assert.equal(br.result,first==='evidence'?'finished':false);
    };
    await Promise.race([run(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker timeout')),15000).unref())]);
    const audit=db.prepare('SELECT * FROM main.phase4_experimental_recovery_evidence').all();
    assert.deepEqual(audit,first==='evidence'?[{id:1,attempt_id:'a',revision:1,actor,reason:'INVESTIGATE_OPEN'}]:[]);
    assert.equal(openAttempt(db,'b'),false);
    assert.deepEqual(db.prepare('SELECT state,revision FROM main.phase4_experimental_ledger_attempts WHERE id=?').get('a'),{state:'UNKNOWN_429',revision:2});
  } finally {
    for(const c of children) if(c.exitCode===null && c.signalCode===null) c.kill();
    await Promise.all(children.map(c=>c.exitCode!==null || c.signalCode!==null ? Promise.resolve() : new Promise(resolve=>c.once('exit',resolve))));
    db.close(); rmSync(dir,{recursive:true,force:true});
  }
});
