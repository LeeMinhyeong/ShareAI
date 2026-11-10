import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';

const scratch=mkdtempSync(join(process.env.LOCALAPPDATA,'hermes','cache','scratch','coordinator-fixture-'));
process.env.DATABASE_URL=`sqlite:${join(scratch,'application.sqlite')}`;
const client=await import('../src/db/client.ts');
const app=await import('../src/db/experimental-atomic-429-app.ts');
const coordinator=await import('../src/db/experimental-429-coordinator.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

test('bounded observations eventually expire all stable finite keys',async()=>{
  assert.equal(typeof coordinator.CooldownCoordinator,'function','missing coordinator');
  const db=client.getDb();
  try {
    db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);`);
    for(const [kind,id,durationNs] of [['siwc','same',10n],['upstream','same',10n],['upstream','b',10n],['siwc','c',10n],['siwc','d',10n],['siwc','indefinite',null]]) {
      db.prepare(`INSERT INTO ${kind==='siwc'?'siwc_account_attempts':'ordinary_account_attempts'} VALUES (?,?)`).run(id,'owner');
      await app.settleAppAttempt({kind,accountId:id,attemptId:'owner',durationNs});
    }
    let nested, calls=0, entered=false;
    const reentrant=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>{calls++; if(!entered) {entered=true; nested=reentrant.tick(); nested.catch(()=>{});} return 0n;}});
    await reentrant.tick();
    await assert.rejects(nested,{message:'Coordinator tick already in progress'});
    assert.equal(calls,1);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_atomic_429_restrictions WHERE duration_ns IS NOT NULL').get().n,5);
    await reentrant.stop();
    // Contract assertions: literal whitespace/control/Unicode keys remain distinct,
    // embedded NUL is rejected, and clock reentry cannot start a second tick.
    for(const id of ['x\0y','\0','\ud800']) {
      db.prepare('INSERT OR REPLACE INTO ordinary_account_attempts VALUES (?,?)').run(id,'owner');
      await assert.rejects(app.settleAppAttempt({kind:'upstream',accountId:id,attemptId:'owner',durationNs:10n}),/Invalid restriction input/);
    }
    const special=[' space ','line\nfeed','한글','é'];
    for(const id of special) {
      db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run(id,'owner');
      await app.settleAppAttempt({kind:'upstream',accountId:id,attemptId:'owner',durationNs:10n});
    }
    let now=0n;
    const specialCoordinator=new coordinator.CooldownCoordinator({capacity:10,pageSize:10,clock:()=>now});
    await specialCoordinator.tick();
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_atomic_429_restrictions WHERE duration_ns IS NOT NULL').get().n,9);
    now=10n; await specialCoordinator.tick();
    for(const id of special) assert.equal(db.prepare('SELECT 1 FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').get('upstream',id),undefined);
    await specialCoordinator.stop();
    for(const [kind,id] of [['siwc','same'],['upstream','same'],['upstream','b'],['siwc','c'],['siwc','d']]) {
      db.prepare(`INSERT INTO ${kind==='siwc'?'siwc_account_attempts':'ordinary_account_attempts'} VALUES (?,?)`).run(id,'owner');
      await app.settleAppAttempt({kind,accountId:id,attemptId:'owner',durationNs:10n});
    }
    const c=new coordinator.CooldownCoordinator({capacity:2,pageSize:1,clock:()=>now});
    for(let i=0;i<12;i++) await c.tick();
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_atomic_429_restrictions WHERE duration_ns IS NOT NULL').get().n,5);
    for(let i=0;i<80;i++){now+=10n;await c.tick();}
    assert.deepEqual(db.prepare('SELECT kind,account_id FROM experimental_atomic_429_restrictions').all(),[{kind:'siwc',account_id:'indefinite'}]);
    await c.stop();
    await assert.rejects(c.tick(),/stopped/);
    const arm=async(id)=>{
      db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run(id,'owner');
      await app.settleAppAttempt({kind:'upstream',accountId:id,attemptId:'owner',durationNs:10n});
    };
    const exists=id=>!!db.prepare('SELECT 1 FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').get('upstream',id);
    await arm('busy'); now=0n;
    const busy=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>now});
    await busy.tick(); now=10n;
    const lock=new Database(db.name,{timeout:0});
    try {
      lock.exec('BEGIN IMMEDIATE');
      await assert.rejects(busy.tick(),e=>e.code==='SQLITE_BUSY');
      assert.ok(exists('busy'));
      lock.exec('ROLLBACK');
      await busy.tick();
      assert.ok(!exists('busy'),'retry must retain elapsed observation');
      await arm('busy'); now=20n;
      await busy.tick();
      await arm('busy'); now=29n;
      await busy.tick(); now=30n;
      await busy.tick(); assert.ok(exists('busy'),'rearm starts a fresh full observation');
      now=39n; await busy.tick(); assert.ok(!exists('busy'));
      await arm('busy'); now=40n; await busy.tick(); now=50n;
      lock.exec('BEGIN IMMEDIATE');
      const pending=busy.tick();
      await assert.rejects(busy.tick(),/already in progress/);
      const stopped=busy.stop();
      await assert.rejects(pending,/stopped/);
      await stopped;
      assert.ok(exists('busy'));
      lock.exec('ROLLBACK');
    } finally {if(lock.inTransaction)lock.exec('ROLLBACK');lock.close();await busy.stop();}
    let bad=false; now=0n;
    const clock=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>{if(bad)throw new Error('clock fault');return now;}});
    await clock.tick(); bad=true; now=10n;
    await assert.rejects(clock.tick(),/clock fault/); assert.ok(exists('busy'));
    bad=false; await clock.tick(); now=19n; await clock.tick(); assert.ok(exists('busy'));
    now=20n; await clock.tick(); assert.ok(!exists('busy')); await clock.stop();
    // Two stopwatches share one clock: a fault on the second invalidates both,
    // including the first stopwatch already sampled in that same tick.
    for (const fault of ['throw','invalid','negative','backwards']) {
      await arm('a-clock'); await arm('b-clock');
      now=0n; let calls=0, inject=false;
      const sharedClock=new coordinator.CooldownCoordinator({capacity:2,pageSize:2,clock:()=>{
        if (inject && ++calls===2) {
          if (fault==='throw') throw new Error('shared clock fault');
          if (fault==='invalid') return NaN;
          if (fault==='negative') return -1n;
          return 8n;
        }
        return now;
      }});
      await sharedClock.tick();
      now=9n; inject=true;
      await assert.rejects(sharedClock.tick(),/clock/i);
      assert.ok(exists('a-clock') && exists('b-clock'));
      inject=false; now=10n; await sharedClock.tick();
      now=19n; await sharedClock.tick();
      assert.ok(exists('a-clock') && exists('b-clock'),`${fault}: pre-fault observations expired early`);
      now=20n; await sharedClock.tick();
      assert.ok(!exists('a-clock') && !exists('b-clock'),`${fault}: full new observation should expire`);
      await sharedClock.stop();
    }
    // End-to-end: a negative first sample is rejected and cannot expire the
    // restriction. AppStopwatch also rejects it, so this does not independently
    // cover the coordinator's negative-value validation branch.
    {
      const id='negative-first';
      await arm(id);
      now=-1n;
      const firstSample=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>now});
      try {
        await assert.rejects(firstSample.tick(),/clock/i);
        assert.ok(exists(id),'invalid first sample must not expire the restriction');
        now=0n; await firstSample.tick();
        now=9n; await firstSample.tick();
        assert.ok(exists(id),'restriction must wait a full duration after a valid sample');
        now=10n; await firstSample.tick();
        assert.ok(!exists(id),'restriction expires after the full valid observation');
      } finally {
        await firstSample.stop();
        db.prepare('DELETE FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').run('upstream',id);
      }
    }
    // An expiry commits before the next retained entry's clock fails. The
    // committed deletion stays deleted, but every surviving observation resets.
    {
      const ids=['expiry-a','expiry-b','expiry-c'];
      for(const id of ids) await arm(id);
      db.prepare("UPDATE experimental_atomic_429_restrictions SET duration_ns=20 WHERE account_id IN ('expiry-b','expiry-c')").run();
      now=0n; let calls=0, inject=false, deletedAtFault=false;
      const reader=new Database(db.name,{readonly:true,fileMustExist:true});
      const readerExists=id=>!!reader.prepare('SELECT 1 FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').get('upstream',id);
      const c=new coordinator.CooldownCoordinator({capacity:3,pageSize:3,clock:()=>{
        if(inject && ++calls===3) {
          deletedAtFault=!readerExists(ids[0]) && readerExists(ids[1]) && readerExists(ids[2]);
          throw new Error('post-expiry clock fault');
        }
        return now;
      }});
      try {
        await c.tick();
        now=10n; inject=true;
        await assert.rejects(c.tick(),/post-expiry clock fault/);
        assert.equal(calls,3);
        assert.ok(deletedAtFault,'fault must occur after the first committed deletion');
        assert.ok(!exists(ids[0]) && exists(ids[1]) && exists(ids[2]));
        inject=false; now=11n; await c.tick();
        now=30n; await c.tick();
        assert.ok(exists(ids[1]) && exists(ids[2]),'survivors must wait a fresh duration');
        now=31n; await c.tick();
        assert.ok(!exists(ids[1]) && !exists(ids[2]),'survivors expire after the fresh wait');
      } finally {
        await c.stop();
        reader.close();
        for(const id of ids) db.prepare('DELETE FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').run('upstream',id);
      }
    }
    // A fault on the later newly discovered candidate also invalidates the
    // retained entries and the earlier candidate sampled in the same scan.
    {
      const ids=['scan-a','scan-b','scan-c','scan-d'];
      await arm(ids[0]); await arm(ids[1]);
      now=0n; let calls=0, inject=false;
      const c=new coordinator.CooldownCoordinator({capacity:4,pageSize:4,clock:()=>{
        if(inject && ++calls===4) throw new Error('later candidate clock fault');
        return now;
      }});
      try {
        await c.tick();
        await arm(ids[2]); await arm(ids[3]);
        now=9n; inject=true;
        await assert.rejects(c.tick(),/later candidate clock fault/);
        assert.equal(calls,4,'two retained entries and the earlier candidate were sampled first');
        for(const id of ids) assert.ok(exists(id),`${id} survives the fault`);
        inject=false; now=10n; await c.tick();
        now=19n; await c.tick();
        for(const id of ids) assert.ok(exists(id),`${id} must wait a fresh duration`);
        now=20n; await c.tick();
        for(const id of ids) assert.ok(!exists(id),`${id} expires after the fresh wait`);
      } finally {
        await c.stop();
        for(const id of ids) db.prepare('DELETE FROM experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').run('upstream',id);
      }
    }
    await arm('invalid');
    const invalid=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>now});
    db.pragma('ignore_check_constraints=ON');
    db.prepare("UPDATE experimental_atomic_429_restrictions SET duration_ns=-1 WHERE account_id='invalid'").run();
    await assert.rejects(invalid.tick(),/Invalid restriction/);
    assert.ok(exists('invalid'));
    db.prepare("UPDATE experimental_atomic_429_restrictions SET duration_ns=10 WHERE account_id='invalid'").run();
    db.pragma('ignore_check_constraints=OFF');
    await invalid.stop();
    // Persisted malformed TEXT must fail closed before any expiry or cursor use.
    for(const expression of ["CAST(x'780079' AS TEXT)","CAST(x'80' AS TEXT)"]) {
      db.exec(`INSERT INTO experimental_atomic_429_restrictions VALUES ('upstream',${expression},1,0)`);
      const badState=new coordinator.CooldownCoordinator({capacity:1,pageSize:1});
      await assert.rejects(badState.tick(),/Invalid restriction state/);
      assert.equal(db.prepare(`SELECT count(*) n FROM experimental_atomic_429_restrictions WHERE account_id=${expression}`).get().n,1);
      await badState.stop();
      db.exec(`DELETE FROM experimental_atomic_429_restrictions WHERE account_id=${expression}`);
    }
    db.prepare("DELETE FROM experimental_atomic_429_restrictions WHERE account_id='invalid'").run();
    // Real monotonic time, not only an injected clock: no early expiration.
    await arm('elapsed');
    db.prepare("UPDATE experimental_atomic_429_restrictions SET duration_ns=40000000 WHERE account_id='elapsed'").run();
    let firstSample;
    const elapsed=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>{const sample=process.hrtime.bigint(); firstSample ??= sample; return sample;}});
    await elapsed.tick(); await elapsed.tick();
    if (!exists('elapsed')) assert.ok(process.hrtime.bigint()-firstSample>=40000000n,'expired before 40ms');
    await new Promise(resolve=>setTimeout(resolve,60));
    await elapsed.tick(); assert.ok(!exists('elapsed')); await elapsed.stop();
    // BINARY pagination and wrap, including visually similar but distinct keys.
    for(const id of ['é','e\u0301','한글','😀']) await arm(id);
    let t=0n;
    const pages=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>t});
    for(let i=0;i<24;i++){await pages.tick(); t+=10n;}
    for(const id of ['é','e\u0301','한글','😀']) assert.ok(!exists(id));
    await pages.stop();
    let stoppedClockCalls=0;
    const immediateStop=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>{stoppedClockCalls++;return 0n;}});
    const pendingStop=immediateStop.tick();
    const stopDone=immediateStop.stop();
    await assert.rejects(pendingStop,/stopped/); await stopDone;
    assert.equal(stoppedClockCalls,0);
    // A deleted tracked row and an indefinite-only page must not be expired.
    await arm('deleted');
    const deleted=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>0n});
    await deleted.tick();
    db.prepare("DELETE FROM experimental_atomic_429_restrictions WHERE account_id='deleted'").run();
    await deleted.tick(); await deleted.tick();
    assert.ok(db.prepare("SELECT 1 FROM experimental_atomic_429_restrictions WHERE account_id='indefinite'").get());
    await deleted.stop();
    // Close the shared DB while an expiry tick is actually waiting on a writer.
    await arm('close-inflight');
    let closeNow=0n;
    const closing=new coordinator.CooldownCoordinator({capacity:1,pageSize:1,clock:()=>closeNow});
    await closing.tick(); closeNow=10n;
    const dbPath=db.name;
    const closeLock=new Database(dbPath,{timeout:0});
    const originalExec=Database.prototype.exec;
    let sawBusy;
    const contention=new Promise(resolve=>{sawBusy=resolve;});
    try {
      closeLock.exec('BEGIN IMMEDIATE');
      Database.prototype.exec=function(sql,...args) {
        try {return originalExec.call(this,sql,...args);}
        catch(error) {if(sql==='BEGIN IMMEDIATE' && error.code==='SQLITE_BUSY') sawBusy(); throw error;}
      };
      const pending=closing.tick();
      pending.catch(()=>{});
      let barrier;
      try {
        await Promise.race([contention,new Promise((_,reject)=>{barrier=setTimeout(()=>reject(new Error('no writer contention')),1000);})]);
      } finally {clearTimeout(barrier);}
      client.closeDatabase();
      closeLock.exec('ROLLBACK');
      await assert.rejects(pending,/closed|changed/i);
      const reader=new Database(dbPath,{readonly:true,fileMustExist:true});
      try {assert.ok(reader.prepare("SELECT 1 FROM experimental_atomic_429_restrictions WHERE account_id='close-inflight'").get());}
      finally {reader.close();}
    } finally {
      Database.prototype.exec=originalExec;
      if(closeLock.inTransaction) closeLock.exec('ROLLBACK');
      closeLock.close(); await closing.stop();
    }
  } finally {client.closeDatabase();rmSync(scratch,{recursive:true,force:true});}
});
