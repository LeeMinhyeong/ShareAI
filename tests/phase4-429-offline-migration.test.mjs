import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import Database from 'better-sqlite3';

// This suite owns every database: no file-backed SQLite, inherited process or network.
const source = readFileSync(new URL('../src/db/offline-429-migration.mjs', import.meta.url), 'utf8');
const context = vm.createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false}});
assert.doesNotMatch(source, /\bimport\s*(?:\(|['"{*])/);
assert.equal((source.match(/export function migrateLegacy429/g) || []).length,1);
const script = new vm.Script(source.replace('export function migrateLegacy429','function migrateLegacy429') + '\n;globalThis.migrate=migrateLegacy429;');
script.runInContext(context, {timeout:1000});
const migrate = context.migrate;
const legacy = `CREATE TABLE account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`;
function fixture() {
  const db = new Database(':memory:');
  db.exec(`${legacy};
  CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
  CREATE TABLE ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
  INSERT INTO ordinary_attempts_schema_marker VALUES (1,1);
  CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
  CREATE TABLE siwc_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
  INSERT INTO siwc_attempts_schema_marker VALUES (1,1);`);
  return db;
}
function seed(db) {
  const insert=db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)');
  for (const r of [['upstream','same',10,20,1],['siwc','same',1,2,2],['upstream','',-1,0,3],['siwc','a\0b',3,4,4],['upstream','x'.repeat(2000),5,6,5]]) insert.run(...r);
  db.exec("INSERT INTO ordinary_account_attempts VALUES ('same','ordinary-open'); INSERT INTO siwc_account_attempts VALUES ('same','siwc-open')");
}
function snapshot(db) {
  return JSON.stringify({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    legacy:db.prepare('SELECT hex(CAST(kind AS BLOB)) k,hex(CAST(account_id AS BLOB)) i,observed_at,until_at,revision FROM account_429_cooldowns ORDER BY rowid').all(),
    ordinary:db.prepare('SELECT * FROM ordinary_account_attempts ORDER BY rowid').all(), siwc:db.prepare('SELECT * FROM siwc_account_attempts ORDER BY rowid').all(), journal:db.pragma('journal_mode',{simple:true})});
}
test('copies all canonical cooldowns without modifying legacy or OPEN rows',()=>{
  const db=fixture(); try { seed(db); const before=snapshot(db);
    db.transaction(()=>migrate(db)).immediate();
    const v=db.prepare('SELECT kind,hex(CAST(account_id AS BLOB)) id,generation,duration_ms FROM account_429_v2_restrictions ORDER BY generation').all();
    assert.equal(v.length,5); assert.deepEqual(v.map(r=>r.generation),[1,2,3,4,5]); assert.ok(v.every(r=>r.duration_ms===null));
    assert.equal(db.prepare('SELECT generation FROM account_429_v2_counter').get().generation,5);
    const now=JSON.parse(snapshot(db)), old=JSON.parse(before); now.schema=old.schema; assert.deepEqual(now,old);
    assert.deepEqual(v.map(r=>[r.kind,r.id]).sort(),db.prepare('SELECT kind,hex(CAST(account_id AS BLOB)) id FROM account_429_cooldowns').all().map(r=>[r.kind,r.id]).sort());
  } finally { db.close(); }
});
test('failure after first real insert rolls back all schema and data',()=>{
  const db=fixture(); try { seed(db); const before=snapshot(db); let observed=false;
    assert.throws(()=>db.transaction(()=>migrate(db,()=>{ observed=db.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n===1; throw Error('injected'); })).immediate());
    assert.equal(observed,true); assert.equal(snapshot(db),before);
  } finally {db.close();}
});
test('rejects malformed bytes, invalid kinds and conflicting objects with rollback',()=>{
 for (const setup of [
   db=>db.exec("INSERT INTO account_429_cooldowns VALUES ('upstream',CAST(X'80' AS TEXT),1,2,1)"),
   db=>db.exec("INSERT INTO account_429_cooldowns VALUES ('invalid','id',1,2,1)"),
   db=>db.exec('CREATE TEMP TABLE account_429_v2_counter (id INTEGER)'),
   db=>db.exec('CREATE TRIGGER surprise AFTER INSERT ON account_429_cooldowns BEGIN SELECT 1; END'),
   db=>db.exec('CREATE TABLE other (id TEXT REFERENCES account_429_cooldowns(account_id))'),
   db=>db.exec('CREATE TABLE account_429_v2_counter (id INTEGER)')
 ]) { const db=fixture(); try {seed(db); setup(db); const before=snapshot(db); assert.throws(()=>db.transaction(()=>migrate(db)).immediate()); assert.equal(snapshot(db),before); } finally {db.close();} }
});
test('requires caller-owned transaction and rejects a noncanonical table',()=>{
 const db=fixture(); try {seed(db); const before=snapshot(db); assert.throws(()=>migrate(db)); assert.equal(snapshot(db),before); } finally {db.close();}
 const bad=new Database(':memory:'); try {bad.exec('CREATE TABLE account_429_cooldowns (kind TEXT, account_id TEXT); INSERT INTO account_429_cooldowns VALUES (\'upstream\',NULL)'); assert.throws(()=>bad.transaction(()=>migrate(bad)).immediate());} finally {bad.close();}
});
test('duplicate legacy key is rejected and counter tampering rolls back',()=>{
 const db=fixture(); try {seed(db); const before=snapshot(db);
   assert.throws(()=>db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('upstream','same',1,2,1));
   assert.throws(()=>db.transaction(()=>migrate(db,()=>db.exec('UPDATE account_429_v2_counter SET generation=9223372036854775807'))).immediate());
   assert.equal(snapshot(db),before);
 } finally {db.close();}
});
