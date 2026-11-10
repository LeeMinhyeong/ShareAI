import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
process.env.DATABASE_URL=`sqlite:${join(process.cwd(),'application.sqlite')}`;
const client=await import('../src/db/client.ts');
const app=await import('../src/db/experimental-atomic-429-app.ts');
const watch=await import('../src/db/experimental-app-stopwatch.ts').catch(e => { if(e.code==='ERR_MODULE_NOT_FOUND') return {}; throw e; });
async function bounded(promise, ms=4000) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('child deadline')),ms);})]); }
  finally {clearTimeout(timer);}
}
assert.equal(typeof watch.AppStopwatch,'function','missing AppStopwatch');
await assert.rejects(new watch.AppStopwatch('upstream','account').check(), /initialized/i);
assert.throws(()=>new watch.AppStopwatch('bad','account'),/Invalid/);
assert.doesNotThrow(()=>new watch.AppStopwatch('siwc',' account'));
assert.throws(()=>new watch.AppStopwatch('siwc','a\0b'),/Invalid/);
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // ADR 0018: the client never creates a database
const db=client.getDb();
try {
  db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);
INSERT INTO ordinary_account_attempts VALUES ('account','owner');`);
  await app.settleAppAttempt({kind:'upstream',accountId:'account',attemptId:'owner',durationNs:10n});
  let now=0n;
  const sw=new watch.AppStopwatch('upstream','account',()=>now);
  assert.equal(await sw.check(),'waiting');
  now=10n;
  assert.equal(await sw.check(),'expired');
  assert.equal(db.prepare('SELECT count(*) AS n FROM experimental_atomic_429_restrictions').get().n,0);
  const arm=async(kind,id,owner,duration)=>{
    db.prepare(`INSERT INTO ${kind==='upstream'?'ordinary_account_attempts':'siwc_account_attempts'} VALUES (?,?)`).run(id,owner);
    return app.settleAppAttempt({kind,accountId:id,attemptId:owner,durationNs:duration});
  };
  const row=(kind,id)=>db.prepare('SELECT generation,duration_ns FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind,id);
  await arm('siwc','zero','z',0n);
  const zero=new watch.AppStopwatch('siwc','zero',()=>now);
  assert.equal(await zero.check(),'waiting');
  assert.equal(await zero.check(),'expired');
  assert.equal(await zero.check(),'absent');
  const huge=9007199254740993n;
  await arm('siwc','large','a',huge);
  now=0n;
  const large=new watch.AppStopwatch('siwc','large',()=>now);
  assert.equal(await large.check(),'waiting');
  now=huge-1n; assert.equal(await large.check(),'waiting');
  now=huge; assert.equal(await large.check(),'expired');
  await arm('upstream','rearm','one',10n);
  now=0n;
  const rearm=new watch.AppStopwatch('upstream','rearm',()=>now);
  assert.equal(await rearm.check(),'waiting');
  now=9n; await arm('upstream','rearm','two',1n);
  assert.equal(await rearm.check(),'waiting');
  now=10n; assert.equal(await rearm.check(),'waiting');
  const restart=new watch.AppStopwatch('upstream','rearm',()=>now);
  assert.equal(await restart.check(),'waiting');
  now=19n; assert.equal(await restart.check(),'waiting');
  now=20n; assert.equal(await restart.check(),'expired');
  await arm('siwc','indefinite','indefinite',null);
  const indefinite=new watch.AppStopwatch('siwc','indefinite',()=>now);
  assert.equal(await indefinite.check(),'waiting'); now+=1000n;
  assert.equal(await indefinite.check(),'waiting'); assert.equal(row('siwc','indefinite').duration_ns,null);
  await arm('upstream','badclock','bc',5n);
  const badclock=new watch.AppStopwatch('upstream','badclock',()=>-1n);
  await assert.rejects(badclock.check(),/clock/); assert.ok(row('upstream','badclock'));
  db.pragma('ignore_check_constraints=ON');
  db.prepare("UPDATE experimental_atomic_429_restrictions SET duration_ns=-1 WHERE account_id='badclock'").run();
  await assert.rejects(badclock.check(),/Invalid restriction/);
  db.prepare("UPDATE experimental_atomic_429_restrictions SET duration_ns=5 WHERE account_id='badclock'").run();
  db.pragma('ignore_check_constraints=OFF');

  await arm('upstream','locked','l',5n);
  now=0n; const locked=new watch.AppStopwatch('upstream','locked',()=>now);
  assert.equal(await locked.check(),'waiting'); now=5n;
  const before=JSON.stringify(db.prepare('SELECT * FROM experimental_atomic_429_marker').all());
  const child=fork(fileURLToPath(new URL('./experimental-atomic-429-app-lock.mjs',import.meta.url)),[db.name],{stdio:['ignore','ignore','ignore','ipc']});
  const exited=once(child,'close');
  try {
    await once(child,'message',{signal:AbortSignal.timeout(4000)});
    const proto=Database.prototype, original=proto.exec; let busy=0;
    try {
      proto.exec=function(sql,...args) {try{return original.call(this,sql,...args);}catch(e){if(sql==='BEGIN IMMEDIATE' && e.code==='SQLITE_BUSY')busy++;throw e;}};
      await assert.rejects(locked.check({timeoutMs:0}),e=>e.code==='SQLITE_BUSY');
      assert.ok(busy>0); assert.ok(row('upstream','locked'));
      await assert.rejects(locked.check({timeoutMs:40}),e=>e.code==='SQLITE_BUSY');
      assert.ok(row('upstream','locked'));
      const ac=new AbortController();
      const pending=locked.check({signal:ac.signal});
      await assert.rejects(locked.check(),/already in progress/);
      ac.abort(new Error('cancelled'));
      await assert.rejects(pending,/cancelled/);
      assert.ok(row('upstream','locked'));
      const retry=locked.check();
      assert.ok(busy>=3);
      await assert.rejects(locked.check(),/already in progress/);
      child.send('release');
      assert.equal(await retry,'expired');
    } finally {proto.exec=original;}
    assert.equal((await bounded(exited))[0],0);
  } finally {if(child.exitCode===null){child.kill();await bounded(exited);}}
  assert.equal(row('upstream','locked'),undefined);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM experimental_atomic_429_marker').all()),before);
  assert.ok(row('upstream','badclock')); assert.ok(row('siwc','indefinite'));
  await arm('upstream','close-wait','cw',5n);
  now=0n; const closing=new watch.AppStopwatch('upstream','close-wait',()=>now);
  assert.equal(await closing.check(),'waiting'); now=5n;
  const path=db.name;
  const lock=fork(fileURLToPath(new URL('./experimental-atomic-429-app-lock.mjs',import.meta.url)),[path],{stdio:['ignore','ignore','ignore','ipc']});
  const lockClosed=once(lock,'close');
  try {
    await once(lock,'message',{signal:AbortSignal.timeout(4000)});
    const proto=Database.prototype, original=proto.exec; let busy=0;
    let pending;
    try {
      proto.exec=function(sql,...args) {try{return original.call(this,sql,...args);}catch(e){if(sql==='BEGIN IMMEDIATE' && e.code==='SQLITE_BUSY')busy++;throw e;}};
      pending=closing.check({timeoutMs:2000});
      assert.ok(busy>0);
      client.closeDatabase();
      lock.send('release');
      await assert.rejects(pending);
    } finally {proto.exec=original;}
    assert.equal((await bounded(lockClosed))[0],0);
    assert.throws(()=>client.requireInitializedDatabase(),/closed|initialized/);
    assert.throws(()=>client.getDb(),/closed/);
    const verify=new Database(path,{readonly:true,fileMustExist:true});
    try {assert.ok(verify.prepare("SELECT 1 FROM experimental_atomic_429_restrictions WHERE account_id='close-wait'").get());}
    finally {verify.close();}
  } finally {if(lock.exitCode===null){lock.kill();await bounded(lockClosed);}}
} finally {client.closeDatabase();}
