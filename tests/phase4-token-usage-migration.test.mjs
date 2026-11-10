import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import {runOffline429} from '../scripts/offline-429-upgrade.mjs';

const flags=['--backup-verified','--all-routers-stopped','--no-outstanding-work','--legacy-schema-provenance-verified','--single-host-trusted-directory','/safe/router.db'];
function fixture() {
  const db=new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE upstream_accounts(id TEXT PRIMARY KEY);
INSERT INTO users VALUES ('user'); INSERT INTO upstream_accounts VALUES ('account');
CREATE TABLE usage_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, upstream_account_id TEXT NOT NULL, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, model TEXT NOT NULL, provider TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, success BOOLEAN NOT NULL, error TEXT, latency_ms INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE);
CREATE INDEX idx_usage_logs_user_timestamp ON usage_logs(user_id, timestamp DESC);
CREATE INDEX idx_usage_logs_account_timestamp ON usage_logs(upstream_account_id, timestamp DESC);
INSERT INTO usage_logs VALUES ('zero','user','account','2020-01-01','m','p',0,0,1,NULL,10);
INSERT INTO usage_logs VALUES ('big','user','account','2020-01-02','m','p',9223372036854775807,9007199254740993,0,'error',20);
CREATE TABLE account_429_cooldowns (kind TEXT NOT NULL, account_id TEXT NOT NULL, observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), PRIMARY KEY(kind, account_id));
CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
CREATE TABLE ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
CREATE TABLE siwc_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
INSERT INTO ordinary_attempts_schema_marker VALUES(1,1); INSERT INTO siwc_attempts_schema_marker VALUES(1,1);
INSERT INTO ordinary_account_attempts VALUES('account','open'); INSERT INTO siwc_account_attempts VALUES('account','siwc-open');
INSERT INTO account_429_cooldowns VALUES('upstream','account',1,2,1),('siwc','account',1,2,1),('upstream','orphan',1,2,2),('siwc','expired-orphan',0,1,3);`);
  return db;
}
function harness(db, fault=false, options={}) {
  let copied=false, fakeOpen=true;
  const attempts=[];
  const stat=(ino,file)=>({dev:1n,ino:BigInt(ino),nlink:1n,isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false});
  const entries={'/':stat(1,false),'/safe':stat(2,false),'/safe/router.db':stat(3,true)};
  const io={constants:{O_RDONLY:0,O_NOFOLLOW:16},lstatSync:p=>entries[p],openSync:()=>1,fstatSync:()=>entries['/safe/router.db'],closeSync:()=>{attempts.push('fd'); if (options.fdError) throw options.fdError;}};
  const proxy=new Proxy(db,{get(o,k){
    if(k==='open') return fakeOpen;
    if(k==='close') return ()=>{attempts.push('db'); if(options.dbError) throw options.dbError; if(!options.silentClose) fakeOpen=false;};
    if(k==='exec' && (fault || options.afterCopy)) return sql=>{ const result=o.exec(sql); if (/INSERT\s+INTO\s+(?:main\.)?usage_logs/i.test(sql)) { copied=o.prepare('SELECT count(*) n FROM usage_logs').get().n>0 && o.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n===4; if(options.afterCopy) options.afterCopy(o); if(fault) throw (Object.hasOwn(options,'primary') ? options.primary : new Error('injected after usage copy')); } return result; };
    const v=o[k]; return typeof v==='function'?v.bind(o):v;
  }});
  return {deps:{fs:io,path:path.posix,platform:'linux',openDatabase:()=>proxy},copied:()=>copied,attempts};
}
const snapshot=db=>({schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(), temp:db.prepare('SELECT type,name,tbl_name,sql FROM temp.sqlite_schema ORDER BY type,name').all(), parents:[db.prepare('SELECT * FROM main.users ORDER BY rowid').all(),db.prepare('SELECT * FROM main.upstream_accounts ORDER BY rowid').all()], markers:[db.prepare('SELECT * FROM main.ordinary_attempts_schema_marker ORDER BY rowid').safeIntegers().all(),db.prepare('SELECT * FROM main.siwc_attempts_schema_marker ORDER BY rowid').safeIntegers().all()], usage:db.prepare('SELECT * FROM main.usage_logs ORDER BY id').safeIntegers().all(), cooldowns:db.prepare('SELECT * FROM main.account_429_cooldowns ORDER BY kind,account_id').safeIntegers().all(), opens:[db.prepare('SELECT * FROM ordinary_account_attempts ORDER BY account_id').all(),db.prepare('SELECT * FROM siwc_account_attempts ORDER BY account_id').all()], journal:db.pragma('journal_mode',{simple:true})});
test('combined offline migration preserves integer history and OPENs with FK on and off',()=>{
  for (const fk of [0,1]) { const db=fixture(),h=harness(db); try {
    db.pragma(`foreign_keys = ${fk}`);
    const before=snapshot(db); assert.equal(db.pragma('foreign_keys',{simple:true}),fk); assert.deepEqual(db.pragma('foreign_key_check'),[]); runOffline429(flags,h.deps);
    const rows=db.prepare('SELECT * FROM usage_logs ORDER BY id').safeIntegers().all();
    assert.deepEqual(rows.map(({usage_known,...rest})=>rest),before.usage);
    assert.deepEqual(rows.map(x=>x.usage_known),[null,null]);
    assert.deepEqual(snapshot(db).cooldowns,before.cooldowns);
    assert.deepEqual(snapshot(db).opens,before.opens);
    assert.deepEqual(db.prepare('SELECT kind,account_id,duration_ms FROM account_429_v2_restrictions ORDER BY kind,account_id').all(),before.cooldowns.map(({kind,account_id})=>({kind,account_id,duration_ms:null})));
    assert.equal(db.pragma('foreign_keys',{simple:true}),fk);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally {db.close();} }
});
test('failure after usage copy rolls back both migrations',()=>{
  const db=fixture(),h=harness(db,true); try {const before=snapshot(db); assert.throws(()=>runOffline429(flags,h.deps),/injected after usage copy/); assert.equal(h.copied(),true); assert.deepEqual(snapshot(db),before); assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'account_429_v2_%'").get().n,0); assert.equal(db.inTransaction,false);} finally {db.close();}
});
test('unrecognized custom index refuses without changing schema or rows',()=>{
  const db=fixture(),h=harness(db); try {db.exec('CREATE INDEX custom_usage_index ON usage_logs(model)'); const before=snapshot(db); assert.throws(()=>runOffline429(flags,h.deps),/usage/i); assert.deepEqual(snapshot(db),before);} finally {db.close();}
});
test('ambient transaction refuses',()=>{
  const db=fixture(),h=harness(db); try {db.exec('BEGIN'); assert.throws(()=>runOffline429(flags,h.deps),/Top-level transaction required/); db.exec('ROLLBACK');} finally {db.close();}
});
test('recognized application history triggers survive the rebuild',()=>{
  const db=fixture(),h=harness(db); try {
    db.exec(`CREATE TABLE user_daily_quota(user_id TEXT);
CREATE TRIGGER protect_user_usage_history BEFORE DELETE ON users WHEN EXISTS (SELECT 1 FROM usage_logs WHERE user_id = OLD.id) OR EXISTS (SELECT 1 FROM user_daily_quota WHERE user_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'user has usage history'); END;
CREATE TRIGGER protect_account_usage_history BEFORE DELETE ON upstream_accounts WHEN EXISTS (SELECT 1 FROM usage_logs WHERE upstream_account_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'account has usage history'); END;`);
    const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
    runOffline429(flags,h.deps);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all(),triggers);
    assert.throws(()=>db.exec("DELETE FROM users WHERE id='user'"),/user has usage history/);
    assert.throws(()=>db.exec("DELETE FROM upstream_accounts WHERE id='account'"),/account has usage history/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='usage_logs' ORDER BY name").all().map(x=>x.name),['idx_usage_logs_account_timestamp','idx_usage_logs_user_timestamp','sqlite_autoindex_usage_logs_1']);
  } finally {db.close();}
});
test('cleanup retains primary including falsey values and attempts both closes',()=>{
  for(const primary of [new Error('synthetic primary'),null,undefined,false,0]) {
    const db=fixture(), dbError=new Error('synthetic db close'), fdError=new Error('synthetic fd close');
    const h=harness(db,true,{primary,dbError,fdError});
    try {
      const before=snapshot(db); let caught, threw=false;
      try { runOffline429(flags,h.deps); } catch(e) { caught=e; threw=true; }
      assert.equal(threw,true); assert.ok(caught instanceof AggregateError);
      assert.equal(caught.errors.length,3);
      assert.strictEqual(caught.errors[0],primary);
      assert.strictEqual(caught.errors[1],dbError);
      assert.strictEqual(caught.errors[2],fdError);
      assert.deepEqual(h.attempts,['db','fd']); assert.equal(h.copied(),true);
      assert.deepEqual(snapshot(db),before); assert.equal(db.inTransaction,false);
    } finally {db.close();}
  }
});
test('confirmed commit with uncertain close is reported distinctly',()=>{
  const db=fixture(),h=harness(db,false,{silentClose:true});
  try { assert.throws(()=>runOffline429(flags,h.deps),e=>e instanceof AggregateError && /commit confirmed/i.test(e.message) && /close uncertain/i.test(e.errors[0].message));
    assert.deepEqual(h.attempts,['db','fd']); assert.equal(db.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n,4);
  } finally {db.close();}
});
test('429 schema is revalidated after usage copy before commit',()=>{
  for (const [sql,reason] of [
    ['DELETE FROM account_429_v2_counter',/Unsafe 429 v2 counter/],
    ['DROP TABLE account_429_v2_schema_marker',/Unsafe 429 v2 schema/],
    ['CREATE TEMP TABLE account_429_v2_counter (id INTEGER)',/Unsafe 429 v2 schema/],
    ['UPDATE account_429_v2_restrictions SET generation=999 WHERE account_id=\'orphan\'',/Unsafe 429 v2 restriction/],
  ]) {
    const db=fixture(),h=harness(db,false,{afterCopy:o=>o.exec(sql)});
    try { const before=snapshot(db); assert.throws(()=>runOffline429(flags,h.deps),reason); assert.equal(h.copied(),true); assert.deepEqual(snapshot(db),before); } finally {db.close();}
  }
});
test('unrecognized legacy DDL, missing index and temporary shadows refuse atomically',()=>{
  for (const [sql,reason] of [
    ['ALTER TABLE usage_logs ADD COLUMN extra INTEGER',/unrecognized legacy usage_logs DDL/],
    ['DROP INDEX idx_usage_logs_account_timestamp',/missing or incompatible index idx_usage_logs_account_timestamp/],
    ['CREATE TEMP TABLE usage_logs (id TEXT)',/temporary object usage_logs/],
    ['CREATE TEMP TABLE account_429_cooldowns (id TEXT)',/Unsafe offline 429 migration/],
    ['CREATE TABLE account_429_v2_counter (id INTEGER)',/Unsafe offline 429 migration/],
  ]) {
    const db=fixture(),h=harness(db);
    try { db.exec(sql); const before=snapshot(db); assert.throws(()=>runOffline429(flags,h.deps),reason); assert.deepEqual(snapshot(db),before); assert.equal(db.inTransaction,false); } finally {db.close();}
  }
});
test('inbound references, views and unknown triggers refuse atomically',()=>{
  for (const [sql,reason] of [
    ['CREATE TABLE dependent (id TEXT REFERENCES usage_logs(id))',/inbound foreign key from main.dependent/],
    ['CREATE VIEW usage_view AS SELECT id FROM usage_logs',/unsupported view main.usage_view/],
    ['CREATE TRIGGER custom_trigger AFTER INSERT ON usage_logs BEGIN SELECT 1; END',/unsupported trigger main.custom_trigger/],
  ]) {
    const db=fixture(),h=harness(db); try {db.exec(sql); const before=snapshot(db); assert.throws(()=>runOffline429(flags,h.deps),reason); assert.deepEqual(snapshot(db),before); assert.equal(db.inTransaction,false);} finally {db.close();}
  }
});
