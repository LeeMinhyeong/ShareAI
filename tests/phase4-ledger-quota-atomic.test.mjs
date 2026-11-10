import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'ledger-quota-'));
const file=path.join(dir,'fixture.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {migrateLedger}=await import('../src/db/durable-ledger-foundation.ts');
const quota=await import('../src/upstream/account-quota.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(); migrateLedger(db);
const repo=new AccountRepository();
const account=repo.create({name:'fixture',provider:'openai',credentialType:'api_key',credentials:'synthetic-key',dailyQuota:2});
const read=()=>({attempts:db.prepare('SELECT id,state FROM phase4_experimental_ledger_attempts').all(),quota:db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(account.id)});

test('caller rollback discards ledger OPEN and real account quota together',()=>{
  assert.equal(typeof quota.createLedgerQuotaReservation,'function');
  const reserve=quota.createLedgerQuotaReservation(account,new AbortController().signal,'attempt-rollback');
  db.exec('BEGIN IMMEDIATE');
  try { assert.equal(reserve(db),undefined); assert.equal(read().attempts.length,1); assert.equal(read().quota.used,1); }
  finally { db.exec('ROLLBACK'); }
  assert.deepEqual(read(),{attempts:[],quota:undefined});
});

function worker(id, target=file) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('./phase4-ledger-quota-worker.mjs',import.meta.url)),target,JSON.stringify(account),id],{stdio:['ignore','pipe','pipe']});
    let out='',err=''; child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    const timer=setTimeout(()=>{child.kill();reject(new Error('worker timeout'));},15000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(`worker ${code}: ${err}`));});
  });
}

test('writer failure after both writes rolls back OPEN and quota',async()=>{
  const {withAsyncWriter}=await import('../src/db/async-writer.ts');
  const reserve=quota.createLedgerQuotaReservation(account,new AbortController().signal,'late-failure');
  let reached=false;
  assert.throws(()=>withAsyncWriter(writer=>{
    reserve(writer);
    assert.deepEqual(writer.prepare('SELECT id,state FROM phase4_experimental_ledger_attempts').all(),[{id:'late-failure',state:'OPEN'}]);
    assert.equal(writer.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(account.id).used,1);
    reached=true;
    throw new Error('injected failure after both writes');
  }),/injected failure after both writes/);
  assert.equal(reached,true);
  assert.deepEqual(read(),{attempts:[],quota:undefined});
});

test('callback refuses to write outside a transaction',()=>{
  const reserve=quota.createLedgerQuotaReservation(account,new AbortController().signal,'outside');
  assert.throws(()=>reserve(db),/active writer transaction/);
  assert.deepEqual(read(),{attempts:[],quota:undefined});
});

test('quota rejection and cancellation roll back the OPEN insertion',()=>{
  const limited=repo.create({name:'exhausted',provider:'openai',credentialType:'api_key',credentials:'fixture-limited',dailyQuota:1});
  const day=new Date().toISOString().slice(0,10);
  db.prepare('INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous) VALUES(?,?,1,0)').run(limited.id,day);
  const reserve=quota.createLedgerQuotaReservation(limited,new AbortController().signal,'exhausted');
  assert.throws(()=>db.transaction(reserve).immediate(db),quota.AccountQuotaExhausted);
  assert.equal(db.prepare('SELECT count(*) n FROM phase4_experimental_ledger_attempts').get().n,0);
  assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(limited.id).used,1);
  const controller=new AbortController();controller.abort();
  assert.throws(()=>db.transaction(quota.createLedgerQuotaReservation(account,controller.signal,'cancelled')).immediate(db));
  assert.deepEqual(read(),{attempts:[],quota:undefined});
});

test('actual quota caller fails closed when commit is applied but its acknowledgement is lost',async()=>{
  // Override only the test process's SQLite exec: apply the real COMMIT, then
  // throw at its return boundary. This is not a real disk/SQLite commit failure.
  const prototype=Object.getPrototypeOf(db), original=prototype.exec;
  let injected=0, starts=0;
  prototype.exec=function(sql) {
    const result=original.call(this,sql);
    if (sql==='COMMIT' && injected++===0) throw new Error('simulated lost commit acknowledgement');
    return result;
  };
  try {
    await assert.rejects(quota.invokeAccountAttempt(account,new AbortController().signal,()=>{
      starts++; return Promise.resolve(new Response('unexpected'));
    }),/simulated lost commit acknowledgement/);
    assert.equal(injected,1);
    assert.equal(starts,0);
    assert.equal(read().quota.used,1);
    // The production caller does not use the experimental ledger.
    assert.deepEqual(read().attempts,[]);
  } finally {
    prototype.exec=original;
    db.prepare('DELETE FROM account_daily_reservations WHERE account_id=?').run(account.id);
  }
});

test('experimental ledger caller fails closed after applied commit loses acknowledgement',async()=>{
  const target=path.join(dir,'uncertain.sqlite'); await db.backup(target);
  const copy=new Database(target); let starts=0, commits=0;
  // The experimental ledger has no production dispatch caller. Exercise a
  // test-only caller with a controlled writer; do not claim production wiring.
  const invoke=async (writer,id,start)=>{
    await writer(quota.createLedgerQuotaReservation(account,new AbortController().signal,id));
    return start();
  };
  const writer=operation=>{copy.transaction(operation).immediate(copy); commits++; throw new Error('simulated lost acknowledgement');};
  try {
    // A successful writer reaches the same caller's dispatch callback.
    const controlTarget=path.join(dir,'ack-control.sqlite'); await db.backup(controlTarget);
    const control=new Database(controlTarget);
    try {
      let controlStarts=0;
      await invoke(operation=>control.transaction(operation).immediate(control),'ack-control',()=>{
        controlStarts++; return Promise.resolve();
      });
      assert.equal(controlStarts,1);
    } finally {control.close();}
    await assert.rejects(invoke(writer,'uncertain',()=>{starts++; return Promise.resolve();}),/lost acknowledgement/);
    assert.equal(commits,1);
    assert.equal(starts,0);
    assert.deepEqual(copy.prepare('SELECT id,state FROM phase4_experimental_ledger_attempts').all(),[{id:'uncertain',state:'OPEN'}]);
    assert.equal(copy.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(account.id).used,1);
    assert.equal(await worker('uncertain-restart',target),'FENCED');
  } finally {copy.close();}
});

test('competing processes commit at most one OPEN and one real quota charge',async()=>{
  const results=await Promise.all([worker('process-one'),worker('process-two')]);
  assert.deepEqual(results.sort(),['COMMITTED','FENCED']);
  const state=read(); assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].state,'OPEN');
  assert.equal(state.quota.used,1);
  assert.equal(await worker('restart'),'FENCED');
  const {finishAttempt}=await import('../src/db/durable-ledger-foundation.ts');
  assert.equal(finishAttempt(db,state.attempts[0].id,1,'UNKNOWN_429'),'finished');
  assert.equal(await worker('after-429'),'FENCED');
  assert.equal(read().quota.used,1);
});

test.after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});
