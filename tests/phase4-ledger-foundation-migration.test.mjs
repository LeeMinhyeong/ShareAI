import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrateLedger,openAttempt,finishAttempt} from '../src/db/durable-ledger-foundation.ts';

test('failed additive migration rolls back all newly created objects',()=>{
  const db=new Database(':memory:',{timeout:0});
  try {
    db.exec('CREATE TABLE phase4_experimental_ledger_restrictions (existing TEXT)');
    assert.throws(()=>migrateLedger(db),/already exists/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('phase4_experimental_ledger_version','phase4_experimental_ledger_attempts')").get().n,0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='phase4_experimental_ledger_restrictions'").get().n,1);
  } finally { db.close(); }
});

test('missing ledger tables fail closed rather than treating schema damage as empty state',()=>{
  const db=new Database(':memory:',{timeout:0});
  try {
    migrateLedger(db); db.exec('DROP TABLE phase4_experimental_ledger_restrictions');
    assert.throws(()=>openAttempt(db,'a'),/Unsupported ledger schema/);
    db.exec("INSERT INTO phase4_experimental_ledger_attempts VALUES ('a','OPEN',1)");
    assert.throws(()=>finishAttempt(db,'a',1,'UNKNOWN_429'),/Unsupported ledger schema/);
    assert.throws(()=>openAttempt(db,'b'),/Unsupported ledger schema/);
  } finally { db.close(); }
});
