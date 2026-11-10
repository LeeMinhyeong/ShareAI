import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {getDb, closeDatabase, requireInitializedDatabase} from '../src/db/client.ts';
import {settleAppAttempt} from '../src/db/experimental-atomic-429-app.ts';

const input={kind:'upstream',accountId:'account',attemptId:'owner',durationNs:5n};
assert.throws(()=>requireInitializedDatabase(), /initializ|closed/i);
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // ADR 0018: the client never creates a database
const db=getDb(); // Ordinary callers retain lazy initialization.
assert.equal(getDb(),db);
assert.equal(requireInitializedDatabase(),db);
db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);
INSERT INTO ordinary_account_attempts VALUES ('account','owner');`);
assert.equal(await settleAppAttempt(input),1n);
if (db.name !== ':memory:') {
  db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('account','next');
  const lock=new Database(db.name,{timeout:0, fileMustExist:true});
  const original=Database.prototype.exec;
  let busy=0;
  try {
    lock.exec('BEGIN IMMEDIATE');
    Database.prototype.exec=function(sql,...args) {
      try { return original.call(this,sql,...args); }
      catch (error) { if (sql==='BEGIN IMMEDIATE' && error.code==='SQLITE_BUSY') busy++; throw error; }
    };
    const pending=settleAppAttempt({...input,attemptId:'next'});
    assert.ok(busy>0,'writer must have reached actual contention');
    closeDatabase();
    lock.exec('ROLLBACK');
    await assert.rejects(pending,/closed|open/i);
    assert.equal(lock.prepare('SELECT generation FROM experimental_atomic_429_marker').get().generation,1);
    assert.ok(lock.prepare("SELECT 1 FROM ordinary_account_attempts WHERE attempt_id='next'").get());
  } finally { Database.prototype.exec=original; if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close(); }
} else {
  // A consumer may close the raw connection directly; the accessor must not return it.
  db.close();
  assert.throws(()=>requireInitializedDatabase(), /initializ|closed/i);
  await assert.rejects(settleAppAttempt(input), /initializ|closed/i);
}
for (let i=0; i<2; i++) await assert.rejects(settleAppAttempt(input), /initializ|closed/i);
assert.throws(()=>requireInitializedDatabase(), /initializ|closed/i);
if (db.name !== ':memory:') assert.throws(()=>getDb(), /closed/i);
