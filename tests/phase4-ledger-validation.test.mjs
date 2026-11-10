import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrateLedger,openAttempt,finishAttempt} from '../src/db/durable-ledger-foundation.ts';

const p='phase4_experimental_ledger_';
function fixture(fn) { const db=new Database(':memory:'); try { migrateLedger(db); fn(db); } finally { db.close(); } }
test('v1 schema missing a primary key is rejected',()=>{
  const db=new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ${p}version(version INTEGER NOT NULL CHECK(version=1)); INSERT INTO ${p}version VALUES(1);
      CREATE TABLE ${p}attempts(id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE ${p}restrictions(source_id TEXT,reason TEXT)`);
    assert.throws(()=>openAttempt(db,'a'));
    assert.throws(()=>migrateLedger(db));
  } finally {db.close();}
});
test('invalid existing state cannot look like an empty ledger',()=>fixture(db=>{
  db.pragma('ignore_check_constraints = ON');
  db.prepare(`INSERT INTO ${p}attempts VALUES ('bad','BOGUS',1)`).run();
  db.pragma('ignore_check_constraints = OFF');
  assert.throws(()=>openAttempt(db,'new'));
}));
test('schema tampering after migration is rejected',()=>fixture(db=>{
  db.exec(`CREATE TRIGGER ${p}evil AFTER INSERT ON ${p}attempts BEGIN DELETE FROM ${p}attempts; END`);
  assert.throws(()=>openAttempt(db,'a'));
}));
test('every operation rejects schema alterations including CHECK, both primary keys, and extras',()=>{
  const variants=[
    [`${p}attempts`, `id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision IN (1,2))`],
    [`${p}attempts`, `id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('OPEN','SUCCESS','UNKNOWN_429')), revision INTEGER NOT NULL CHECK(revision IN (1,2))`],
    [`${p}restrictions`, `source_id TEXT NOT NULL REFERENCES ${p}attempts(id), reason TEXT NOT NULL CHECK(reason='UNKNOWN_429')`],
  ];
  for(const [table,columns] of variants) fixture(db=>{
    db.exec(`DROP TABLE ${table}; CREATE TABLE ${table} (${columns})`);
    for(const operation of [()=>migrateLedger(db),()=>openAttempt(db,'a'),()=>finishAttempt(db,'a',1,'SUCCESS')]) assert.throws(operation,/schema/);
  });
  fixture(db=>{db.exec(`CREATE INDEX custom_index ON ${p}attempts(state)`); assert.throws(()=>openAttempt(db,'a'),/schema/);});
  fixture(db=>{db.exec(`CREATE TEMP TABLE ${p.toUpperCase()}ATTEMPTS(id TEXT)`); assert.throws(()=>openAttempt(db,'a'),/schema/);});
});
test('versions and inconsistent persisted states fail closed after initial use',()=>{
  const corruptions=[
    `DELETE FROM ${p}version`,
    `INSERT INTO ${p}version VALUES(1)`,
    `UPDATE ${p}version SET version=3`,
    `INSERT INTO ${p}attempts VALUES('x','OPEN',2)`,
    `INSERT INTO ${p}attempts VALUES('x','SUCCESS',1)`,
    `INSERT INTO ${p}attempts VALUES('x','UNKNOWN_429',2)`,
    `INSERT INTO ${p}restrictions VALUES('missing','UNKNOWN_429')`,
    `INSERT INTO ${p}attempts VALUES('x','OPEN',1),('y','OPEN',1)`,
    `INSERT INTO ${p}attempts VALUES('bad id','SUCCESS',2)`,
  ];
  for(const sql of corruptions) fixture(db=>{
    assert.equal(openAttempt(db,'initial'),true);
    assert.equal(finishAttempt(db,'initial',1,'SUCCESS'),'finished');
    db.pragma('foreign_keys = OFF'); db.pragma('ignore_check_constraints = ON'); db.exec(sql); db.pragma('ignore_check_constraints = OFF'); db.pragma('foreign_keys = ON');
    for(const operation of [()=>migrateLedger(db),()=>openAttempt(db,'new'),()=>finishAttempt(db,'initial',2,'SUCCESS')]) assert.throws(operation);
  });
});
test('failed finalization rolls back its restriction write',()=>fixture(db=>{
  assert.equal(openAttempt(db,'a'),true);
  const prepare=db.prepare.bind(db);
  db.prepare=(sql)=>sql.startsWith(`UPDATE ${p}attempts`) ? {run:()=>({changes:0})} : prepare(sql);
  try { assert.throws(()=>finishAttempt(db,'a',1,'UNKNOWN_429'),/CAS failed/); }
  finally { db.prepare=prepare; }
  assert.equal(db.prepare(`SELECT count(*) n FROM ${p}restrictions`).get().n,0);
  assert.equal(db.prepare(`SELECT state FROM ${p}attempts WHERE id='a'`).get().state,'OPEN');
}));
