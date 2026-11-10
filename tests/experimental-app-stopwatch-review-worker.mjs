import assert from 'node:assert/strict';
import {join} from 'node:path';
import Database from 'better-sqlite3';
process.env.DATABASE_URL=`sqlite:${join(process.cwd(),'application.sqlite')}`;
const client=await import('../src/db/client.ts');
const {AppStopwatch}=await import('../src/db/experimental-app-stopwatch.ts');
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // ADR 0018: the client never creates a database
const db=client.getDb();
try {
  db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,1);
INSERT INTO experimental_atomic_429_restrictions VALUES ('upstream','account',1,10);`);
  const row=()=>db.prepare('SELECT * FROM experimental_atomic_429_restrictions').all();
  const before=row();
  let now=0n;
  let failure=false;
  let calls=0;
  const sw=new AppStopwatch('upstream','account',()=>{calls++; if(failure && calls===2) throw new Error('clock failure'); return now;});
  assert.equal(await sw.check(),'waiting');
  now=10n;
  if(process.argv[2]==='getter') {
    const lock=new Database(db.name,{timeout:0});
    lock.exec('BEGIN IMMEDIATE');
    try {
      let reads=0, signals=0;
      const options={get timeoutMs(){return ++reads<=4 ? 0 : Infinity;},get signal(){signals++; return undefined;}};
      const start=performance.now();
      await assert.rejects(sw.check(options),e=>e.code==='SQLITE_BUSY');
      assert.ok(performance.now()-start<1000);
      assert.equal(reads,1);
      assert.equal(signals,1);
      assert.deepEqual(row(),before);
    } finally {lock.exec('ROLLBACK');lock.close();}
    for(const property of ['timeoutMs','signal']) {
      const options={get [property](){throw new Error('getter failure');}};
      await assert.rejects(sw.check(options),/getter failure/);
      assert.deepEqual(row(),before);
    }
  } else {
    calls=0; failure=true;
    const original=Database.prototype.exec;
    let begins=0, rollbacks=0;
    try {
      Database.prototype.exec=function(sql,...args) {
        if(sql==='BEGIN IMMEDIATE') begins++;
        if(sql==='ROLLBACK') rollbacks++;
        return original.call(this,sql,...args);
      };
      await assert.rejects(sw.check(),/clock failure/);
    } finally {Database.prototype.exec=original;}
    assert.equal(begins,1); assert.equal(rollbacks,1);
    assert.deepEqual(row(),before);
    failure=false; now=20n;
    assert.equal(await sw.check(),'waiting','clock exception must reset observation');
    now=29n; assert.equal(await sw.check(),'waiting');
    now=30n; assert.equal(await sw.check(),'expired');
    db.prepare("INSERT INTO experimental_atomic_429_restrictions VALUES ('upstream','account',1,10)").run();
    let sample=()=>{throw new Error('initial clock failure');};
    const extra=new AppStopwatch('upstream','account',()=>sample());
    await assert.rejects(extra.check(),/initial clock failure/);
    assert.deepEqual(row(),before);
    sample=()=>40n; assert.equal(await extra.check(),'waiting');
    sample=()=>39n; await assert.rejects(extra.check(),/Invalid monotonic clock/);
    assert.deepEqual(row(),before);
    sample=()=>50n; assert.equal(await extra.check(),'waiting');
    sample=()=>59n; assert.equal(await extra.check(),'waiting');
    sample=()=>60n; assert.equal(await extra.check(),'expired');
  }
} finally {client.closeDatabase();}
