import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

// This worker is launched in an empty test-owned directory with a synthetic env.
const target=join(process.cwd(),'application.sqlite');
process.env.DATABASE_URL=`sqlite:${target}`;
const client=await import('../src/db/client.ts');
const experiment=await import('../src/db/experimental-atomic-429-settle.ts');
const app=await import('../src/db/experimental-atomic-429-app.ts');
let reader;
try {
  const db=client.getDb();
  assert.equal(db.name,target);
  db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);
INSERT INTO ordinary_account_attempts VALUES ('synthetic-account','synthetic-owner');`);
  assert.equal(typeof experiment.armAndSettleInWriter,'undefined','raw transaction callback must not be exported');
  assert.equal(typeof app.settleAppAttempt,'function');
  assert.equal(await app.settleAppAttempt({kind:'upstream',accountId:'synthetic-account',attemptId:'synthetic-owner',durationNs:10n}),1n);
  reader=new Database(target,{fileMustExist:true,readonly:true});
  assert.equal(reader.prepare('SELECT 1 FROM ordinary_account_attempts').get(),undefined);
  assert.deepEqual(reader.prepare('SELECT generation,duration_ns FROM experimental_atomic_429_restrictions').safeIntegers().get(),{generation:1n,duration_ns:10n});
  reader.close(); reader=undefined;
  const settle=(kind, accountId, attemptId, durationNs) => app.settleAppAttempt({kind,accountId,attemptId,durationNs});
  db.prepare('INSERT INTO siwc_account_attempts VALUES (?,?)').run('synthetic-account','siwc-owner');
  await assert.rejects(settle('siwc','synthetic-account','wrong',5n), /ownership/);
  assert.equal(await settle('siwc','synthetic-account','siwc-owner',5n),2n);
  db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('synthetic-account','next');
  assert.equal(await settle('upstream','synthetic-account','next',2n),3n);
  db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('synthetic-account','indefinite');
  assert.equal(await settle('upstream','synthetic-account','indefinite',null),4n);
  db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('synthetic-account','after-indefinite');
  assert.equal(await settle('upstream','synthetic-account','after-indefinite',99n),5n);
  assert.deepEqual(db.prepare('SELECT kind,generation,duration_ns FROM experimental_atomic_429_restrictions ORDER BY kind').safeIntegers().all(), [
    {kind:'siwc',generation:2n,duration_ns:5n}, {kind:'upstream',generation:5n,duration_ns:null}]);
  db.exec('BEGIN IMMEDIATE');
  await assert.rejects(settle('upstream','synthetic-account','x',1n), /active transaction/);
  db.exec('ROLLBACK');
  db.exec('CREATE TEMP TABLE experimental_atomic_429_marker(id)');
  await assert.rejects(settle('upstream','synthetic-account','x',1n), /schema/);
  db.exec('DROP TABLE temp.experimental_atomic_429_marker');
  db.exec('CREATE TRIGGER unsafe_experiment AFTER UPDATE ON experimental_atomic_429_marker BEGIN SELECT 1; END');
  await assert.rejects(settle('upstream','synthetic-account','x',1n), /schema/);
  db.exec('DROP TRIGGER unsafe_experiment');
  db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('rollback','owner');
  const proto=Database.prototype, originalPrepare=proto.prepare;
  let injected=0;
  try {
    proto.prepare=function(sql,...args) {
      if (sql.startsWith('DELETE FROM main.ordinary_account_attempts')) {
        const marker=this.prepare('SELECT generation FROM main.experimental_atomic_429_marker').get();
        assert.equal(marker.generation,6);
        assert.ok(this.prepare("SELECT 1 FROM main.experimental_atomic_429_restrictions WHERE account_id='rollback'").get());
        injected++;
        // A test-owned SQL error, not a disk or commit fault.
        return originalPrepare.call(this,'SELECT * FROM no_such_fixture_table');
      }
      return originalPrepare.call(this,sql,...args);
    };
    await assert.rejects(settle('upstream','rollback','owner',7n), /no such table/);
  } finally { proto.prepare=originalPrepare; }
  assert.equal(injected,1);
  assert.equal(db.prepare('SELECT generation FROM experimental_atomic_429_marker').get().generation,5);
  assert.ok(db.prepare("SELECT 1 FROM ordinary_account_attempts WHERE account_id='rollback'").get());
  assert.equal(db.prepare("SELECT 1 FROM experimental_atomic_429_restrictions WHERE account_id='rollback'").get(),undefined);
  const lock=fork(fileURLToPath(new URL('./experimental-atomic-429-app-lock.mjs',import.meta.url)),[target],{stdio:['ignore','ignore','ignore','ipc']});
  const exited=once(lock,'exit');
  try {
    await once(lock,'message',{signal:AbortSignal.timeout(4000)});
    let busy=0, callbacks=0;
    const originalExec=proto.exec;
    try {
      proto.prepare=function(sql,...args) { if (sql.startsWith('UPDATE main.experimental_atomic_429_marker')) callbacks++; return originalPrepare.call(this,sql,...args); };
      proto.exec=function(sql,...args) { try { return originalExec.call(this,sql,...args); } catch (e) { if (sql==='BEGIN IMMEDIATE' && e.code==='SQLITE_BUSY') busy++; throw e; } };
      const pending=settle('upstream','rollback','owner',7n);
      assert.ok(busy>0,'actual asynchronous writer observed SQLITE_BUSY');
      assert.equal(callbacks,0);
      lock.send('release');
      assert.equal(await pending,6n);
      assert.equal(callbacks,1);
    } finally { proto.exec=originalExec; proto.prepare=originalPrepare; }
    assert.equal((await exited)[0],0);
  } finally { if (lock.exitCode===null) { lock.kill(); await Promise.race([exited, new Promise((_,reject)=>setTimeout(()=>reject(new Error('lock child did not exit')),3000))]); } }
  reader=new Database(target,{fileMustExist:true,readonly:true});
  assert.equal(reader.prepare('SELECT generation FROM experimental_atomic_429_marker').safeIntegers().get().generation,6n);
  assert.deepEqual(reader.prepare("SELECT generation,duration_ns FROM experimental_atomic_429_restrictions WHERE kind='upstream' AND account_id='rollback'").safeIntegers().get(),{generation:6n,duration_ns:7n});
  assert.equal(reader.prepare("SELECT 1 FROM ordinary_account_attempts WHERE account_id='rollback'").get(),undefined);
  reader.close(); reader=undefined;
  db.prepare('UPDATE experimental_atomic_429_marker SET generation=?').run(9007199254740993n);
  db.prepare('INSERT INTO siwc_account_attempts VALUES (?,?)').run('large','owner');
  assert.equal(await settle('siwc','large','owner',9223372036854775807n),9007199254740994n);
  reader=new Database(target,{fileMustExist:true,readonly:true});
  assert.deepEqual(reader.prepare("SELECT generation,duration_ns FROM experimental_atomic_429_restrictions WHERE kind='siwc' AND account_id='large'").safeIntegers().get(),{generation:9007199254740994n,duration_ns:9223372036854775807n});
} finally { reader?.close(); client.closeDatabase(); }
