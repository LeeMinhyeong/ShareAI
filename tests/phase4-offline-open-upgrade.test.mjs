// ADR 0018 init fixture: inline startup children run db:init's provisioning first when the file is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { UPGRADE_DEFERRED } from './helpers/upgrade-deferred.mjs';

const flags = ['--all-routers-stopped','--no-outstanding-work','--backup-verified','--genuinely-pre-open'];
const ordinaryFlags = ['--all-routers-stopped','--no-outstanding-work','--backup-verified','--genuinely-pre-siwc-open'];
const run = (...args) => spawnSync(process.execPath, ['scripts/offline-open-upgrade.mjs', ...args], {encoding:'utf8'});
const schema = readFileSync('scripts/legacy-740df93-schema.sql','utf8');
function fixture(fn) { const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'offline-upgrade-')); try { fn(path.join(dir,'synthetic.db')); } finally { rmSync(dir,{recursive:true,force:true}); } }
function create(file) { const db=new Database(file); db.pragma('foreign_keys = ON'); db.exec(schema); db.exec(`
  INSERT INTO quota_migration_marker VALUES (1);
  INSERT INTO users(id,api_key_hash,name,email,tier) VALUES ('u','synthetic-hash','name','u@example.invalid','free');
  INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','synthetic','openai','oauth','synthetic-secret','active','2020');
  INSERT INTO oauth_refresh_intents VALUES ('fingerprint','attempt','a','time');
  INSERT INTO account_pool_rules(id,user_id,provider,model_pattern,allowed_account_ids,selection_strategy) VALUES ('r','u','openai','*','["a"]','round_robin');
  INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES ('log','u','a','2020-01-01T12:00:00.000Z','synthetic-model','openai',12,34,1,56);
  INSERT INTO settings(key,value) VALUES ('synthetic-setting','synthetic-value');
  INSERT INTO user_daily_quota(user_id,day,used) VALUES ('u','2020-01-01',1);
`); assert.deepEqual(db.pragma('foreign_key_check'),[]); db.close(); }
function snapshot(file) { const db=new Database(file,{readonly:true}); try { const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(); const rows=Object.fromEntries(tables.map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()])); return { schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(), rows, users:rows.users, accounts:rows.upstream_accounts, intents:rows.oauth_refresh_intents, journal:db.pragma('journal_mode',{simple:true}) }; } finally {db.close();} }

test('offline upgrader requires explicit safety attestations before accessing a file', () => {
  const result = spawnSync(process.execPath, ['scripts/offline-open-upgrade.mjs', 'not-a-database'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /attest/i);
});
test('recognized initialized baseline upgrades without changing legacy records', () => fixture(file=>{ create(file); const before=snapshot(file); for (const [name, rows] of Object.entries(before.rows)) assert.ok(rows.length > 0, `fixture must populate ${name}`); const r=run(...flags,file); assert.equal(r.status,0,r.stderr); const after=snapshot(file); assert.deepEqual(Object.fromEntries(Object.keys(before.rows).map(name=>[name,after.rows[name]])),before.rows); assert.equal(after.journal,before.journal); const db=new Database(file,{readonly:true}); try { assert.deepEqual(db.prepare('SELECT * FROM ordinary_attempts_schema_marker').all(),[{id:1,version:1}]); assert.deepEqual(db.prepare('SELECT * FROM ordinary_account_attempts').all(),[]); } finally {db.close();} }));
test('unknown schema and target collisions fail without mutation', () => fixture(file=>{ create(file); const db=new Database(file); db.exec('CREATE VIEW ordinary_account_attempts AS SELECT 1'); db.close(); const before=snapshot(file); const r=run(...flags,file); assert.notEqual(r.status,0); assert.deepEqual(snapshot(file),before); }));
test('refuses a directory junction without modifying the database', t => fixture(file=>{ create(file); const before=snapshot(file); const link=path.join(path.dirname(file),'link'); try { symlinkSync(path.dirname(file),link,process.platform==='win32'?'junction':'dir'); } catch(e) { if (['EPERM','EACCES','ENOTSUP'].includes(e.code)) { t.skip(`link unavailable: ${e.code}`); return; } throw e; } const r=run(...flags,path.join(link,'synthetic.db')); assert.notEqual(r.status,0); assert.deepEqual(snapshot(file),before); }));
test('a simulated failure after first DDL rolls back schema and all rows', () => fixture(file=>{
 create(file); const before=snapshot(file); const preload=path.join(path.dirname(file),'fault.mjs');
 writeFileSync(preload, `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};\nconst original=Database.prototype.exec; Database.prototype.exec=function(sql) { if (sql.includes('CREATE TABLE main.ordinary_account_attempts')) { original.call(this, sql.slice(0,sql.indexOf(';')+1)); console.error('TEST_FIRST_DDL_DONE'); throw new Error('simulated fault'); } return original.call(this,sql); };`);
 const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'scripts/offline-open-upgrade.mjs',...flags,file],{encoding:'utf8'}); assert.notEqual(r.status,0); assert.match(r.stderr,/TEST_FIRST_DDL_DONE/); assert.deepEqual(snapshot(file),before);
}));
test('a failure during SIWC DDL rolls back earlier ordinary provisioning', () => fixture(file=>{
 create(file); const before=snapshot(file); const preload=path.join(path.dirname(file),'siwc-fault.mjs');
 writeFileSync(preload, `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};\nconst original=Database.prototype.exec; Database.prototype.exec=function(sql) { if (sql.includes('CREATE TABLE main.siwc_account_attempts')) { original.call(this, sql.slice(0,sql.indexOf(';')+1)); console.error('TEST_SIWC_DDL_DONE'); throw new Error('simulated fault'); } return original.call(this,sql); };`);
 const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'scripts/offline-open-upgrade.mjs',...flags,file],{encoding:'utf8'}); assert.notEqual(r.status,0); assert.match(r.stderr,/TEST_SIWC_DDL_DONE/); assert.deepEqual(snapshot(file),before);
}));
for (const [label,sql] of [
 ['case collision','CREATE VIEW Ordinary_Account_Attempts AS SELECT 1'],
 ['index','DROP INDEX idx_usage_logs_user_timestamp'],
 ['trigger','DROP TRIGGER protect_user_usage_history'],
 ['foreign key data',"INSERT INTO user_daily_quota VALUES ('missing','2020-01-01',1)"]
]) test(`refuses ${label} tampering without mutation`,()=>fixture(file=>{ create(file); const db=new Database(file); db.pragma('foreign_keys = OFF'); db.exec(sql); db.close(); const before=snapshot(file); const r=run(...flags,file); assert.notEqual(r.status,0); assert.deepEqual(snapshot(file),before); }));
test('file symlink is refused without changing the target', t => fixture(file=>{ create(file); const before=snapshot(file); const link=path.join(path.dirname(file),'link.db'); try { symlinkSync(file,link,'file'); } catch(e) { if (['EPERM','EACCES','ENOTSUP'].includes(e.code)) { t.skip(`file symlink unavailable: ${e.code}`); return; } throw e; } assert.notEqual(run(...flags,link).status,0); assert.deepEqual(snapshot(file),before); }));
test('SQLite backup includes live WAL content and backup can be upgraded', async () => {
 const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'offline-wal-')); const file=path.join(dir,'source.db'); const copy=path.join(dir,'backup.db'); let db;
 try { create(file); db=new Database(file); db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0'); db.exec("INSERT INTO settings VALUES ('wal-test','synthetic')"); assert.ok(existsSync(file+'-wal')); await db.backup(copy); const original=snapshot(file); const backup=snapshot(copy); assert.deepEqual(backup.rows,original.rows); db.close(); db=undefined; const r=run(...flags,copy); assert.equal(r.status,0,r.stderr); const after=snapshot(copy); assert.deepEqual(Object.fromEntries(Object.keys(backup.rows).map(n=>[n,after.rows[n]])),backup.rows); }
 finally { if(db) db.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('previous upgrader ordinary-only historical baseline preserves unknown OPEN', {skip: UPGRADE_DEFERRED}, () => fixture(file=>{
 create(file); const db=new Database(file); db.exec(`CREATE TABLE main.ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
 CREATE TABLE main.ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
 INSERT INTO ordinary_attempts_schema_marker VALUES (1,1); INSERT INTO ordinary_account_attempts VALUES ('a','unknown');`); db.close();
 const before=snapshot(file); const r=run(...ordinaryFlags,file); assert.equal(r.status,0,r.stderr); const after=snapshot(file);
 assert.deepEqual(Object.fromEntries(Object.keys(before.rows).map(name=>[name,after.rows[name]])),before.rows);
 assert.deepEqual(after.rows.siwc_attempts_schema_marker,[{id:1,version:1}]);
 const started=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase()"],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'}});
 assert.equal(started.status,0,started.stderr); assert.deepEqual(snapshot(file).rows.ordinary_account_attempts,before.rows.ordinary_account_attempts);
}));
test('ordinary-only current baseline preserves pending OPEN and gains SIWC provisioning', {skip: UPGRADE_DEFERRED}, () => fixture(file=>{
 const env={...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'};
 const init=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase()"],{encoding:'utf8',timeout:30000,env});
 const first=init(); assert.equal(first.status,0,first.stderr);
 const db=new Database(file); db.exec("DROP TABLE siwc_account_attempts; DROP TABLE siwc_attempts_schema_marker; INSERT INTO ordinary_account_attempts VALUES ('synthetic-account','unknown-outcome')"); db.close();
 const before=snapshot(file); const base=path.join(path.dirname(file),'ordinary-baseline.db');
 const source=new Database(file,{readonly:true}); source.prepare('VACUUM INTO ?').run(base); source.close();
 const preload=path.join(path.dirname(file),'ordinary-siwc-fault.mjs');
 writeFileSync(preload, `import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};\nconst original=Database.prototype.exec; Database.prototype.exec=function(sql) { if (sql.includes('CREATE TABLE main.siwc_account_attempts')) { original.call(this, sql.slice(0,sql.indexOf(';')+1)); console.error('TEST_SIWC_DDL_DONE'); throw new Error('simulated fault'); } return original.call(this,sql); };`);
 const prior=snapshot(base); const fault=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,'scripts/offline-open-upgrade.mjs',...ordinaryFlags,base],{encoding:'utf8'});
 assert.notEqual(fault.status,0); assert.match(fault.stderr,/TEST_SIWC_DDL_DONE/); assert.deepEqual(snapshot(base),prior);
 const result=run(...ordinaryFlags,file); assert.equal(result.status,0,result.stderr);
 const after=snapshot(file); assert.deepEqual(Object.fromEntries(Object.keys(before.rows).map(name=>[name,after.rows[name]])),before.rows);
 assert.deepEqual(after.rows.siwc_account_attempts,[]); assert.deepEqual(after.rows.siwc_attempts_schema_marker,[{id:1,version:1}]);
 for (const [i,sql] of [
   'DELETE FROM ordinary_attempts_schema_marker',
   'CREATE TRIGGER hostile AFTER DELETE ON ordinary_account_attempts BEGIN SELECT 1; END',
   'CREATE INDEX hostile_idx ON ordinary_account_attempts(attempt_id)',
   'CREATE TABLE hostile_fk(x TEXT REFERENCES siwc_account_attempts(account_id))',
   'CREATE VIEW Siwc_Account_Attempts AS SELECT 1'
 ].entries()) {
   const copy=path.join(path.dirname(file),`tampered-${i}.db`); const src=new Database(base,{readonly:true});
   src.prepare('VACUUM INTO ?').run(copy); src.close();
   const changed=new Database(copy); changed.exec(sql); changed.close(); const prior=snapshot(copy);
   assert.notEqual(run(...ordinaryFlags,copy).status,0,sql); assert.deepEqual(snapshot(copy),prior,sql);
 }
 for (const [i,sql] of ['DROP TABLE siwc_account_attempts','DROP TABLE siwc_attempts_schema_marker'].entries()) {
   const copy=path.join(path.dirname(file),`partial-${i}.db`); const src=new Database(file,{readonly:true}); src.prepare('VACUUM INTO ?').run(copy); src.close();
   const changed=new Database(copy); changed.exec(sql); changed.close(); const prior=snapshot(copy);
   assert.notEqual(run(...ordinaryFlags,copy).status,0,sql); assert.deepEqual(snapshot(copy),prior,sql);
 }
 const started=init(); assert.equal(started.status,0,started.stderr);
}));
// Deferred with the upgrade path: the upgrader currently refuses an uncorrupted v2 baseline too
// (verified 2026-11-10: the control run exits 1 with the same generic refusal), so a refusal here
// cannot be attributed to the marker. Re-enable together with a passing uncorrupted control.
test('ordinary-only marker corruption is refused unchanged', {skip: UPGRADE_DEFERRED}, () => fixture(file=>{
 const env={...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'};
 const init=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase()"],{encoding:'utf8',timeout:30000,env});
 const started=init();
 assert.equal(started.status,0,started.stderr);
 const db=new Database(file); try { db.exec(`DROP TABLE siwc_account_attempts; DROP TABLE siwc_attempts_schema_marker;
 INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','synthetic','openai','oauth','synthetic-secret','active','2020');
 INSERT INTO account_daily_reservations VALUES ('a','2020-01-01',7,0);
 INSERT INTO ordinary_account_attempts VALUES ('a','unknown');`); } finally { db.close(); }
 const cases=[
  ['missing account marker','DELETE FROM account_quota_migration_marker'],
  ['invalid account marker','UPDATE account_quota_migration_marker SET id=2'],
  ['extra account marker','INSERT INTO account_quota_migration_marker VALUES (2)'],
  ['missing ordinary marker','DELETE FROM ordinary_attempts_schema_marker'],
  ['invalid ordinary id','UPDATE ordinary_attempts_schema_marker SET id=2'],
  ['invalid ordinary version','UPDATE ordinary_attempts_schema_marker SET version=2'],
  ['extra ordinary marker','INSERT INTO ordinary_attempts_schema_marker VALUES (2,1)']
 ];
 for (const [i,[label,sql]] of cases.entries()) {
  const copy=path.join(path.dirname(file),`marker-${i}.db`); const source=new Database(file,{readonly:true}); source.prepare('VACUUM INTO ?').run(copy); source.close();
  const changed=new Database(copy); changed.pragma('ignore_check_constraints = ON'); changed.exec(sql); changed.close();
  const before=snapshot(copy); const result=run(...ordinaryFlags,copy);
  assert.notEqual(result.status,0,label); assert.deepEqual(snapshot(copy),before,label);
 }
}));
test('ordinary-only marker corruption is refused unchanged and populated quota survives upgrade and startup', {skip: UPGRADE_DEFERRED}, () => fixture(file=>{
 const env={...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'};
 const init=()=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase()"],{encoding:'utf8',timeout:30000,env});
 const started=init();
 assert.equal(started.status,0,started.stderr);
 const db=new Database(file); try { db.exec(`DROP TABLE siwc_account_attempts; DROP TABLE siwc_attempts_schema_marker;
 INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','synthetic','openai','oauth','synthetic-secret','active','2020');
 INSERT INTO account_daily_reservations VALUES ('a','2020-01-01',7,0);
 INSERT INTO ordinary_account_attempts VALUES ('a','unknown');`); } finally { db.close(); }
 const cases=[
  ['missing account marker','DELETE FROM account_quota_migration_marker'],
  ['invalid account marker','UPDATE account_quota_migration_marker SET id=2'],
  ['extra account marker','INSERT INTO account_quota_migration_marker VALUES (2)'],
  ['missing ordinary marker','DELETE FROM ordinary_attempts_schema_marker'],
  ['invalid ordinary id','UPDATE ordinary_attempts_schema_marker SET id=2'],
  ['invalid ordinary version','UPDATE ordinary_attempts_schema_marker SET version=2'],
  ['extra ordinary marker','INSERT INTO ordinary_attempts_schema_marker VALUES (2,1)']
 ];
 for (const [i,[label,sql]] of cases.entries()) {
  const copy=path.join(path.dirname(file),`marker-${i}.db`); const source=new Database(file,{readonly:true}); source.prepare('VACUUM INTO ?').run(copy); source.close();
  const changed=new Database(copy); changed.pragma('ignore_check_constraints = ON'); changed.exec(sql); changed.close();
  const before=snapshot(copy); const result=run(...ordinaryFlags,copy);
  assert.notEqual(result.status,0,label); assert.deepEqual(snapshot(copy),before,label);
 }
 const before=snapshot(file); const result=run(...ordinaryFlags,file); assert.equal(result.status,0,result.stderr);
 const after=snapshot(file); assert.deepEqual(Object.fromEntries(Object.keys(before.rows).map(name=>[name,after.rows[name]])),before.rows);
 const restarted=init(); assert.equal(restarted.status,0,restarted.stderr);
 const final=snapshot(file); assert.deepEqual(final.rows.account_daily_reservations,before.rows.account_daily_reservations);
 assert.deepEqual(final.rows.account_quota_migration_marker,[{id:1}]); assert.deepEqual(final.rows.ordinary_account_attempts,before.rows.ordinary_account_attempts);
}));
test('missing path is never created', () => fixture(file=>{ const r=run(...flags,file); assert.notEqual(r.status,0); assert.equal(existsSync(file),false); }));
test('unrecognized SQLite application or user version is refused unchanged', () => fixture(file=>{ create(file); const db=new Database(file); db.pragma('user_version = 7'); db.close(); const before=snapshot(file); const r=run(...flags,file); assert.notEqual(r.status,0); assert.deepEqual(snapshot(file),before); }));
test('fixture matches schema constructed from historical source initialization', {skip: UPGRADE_DEFERRED}, () => fixture(file=>{
 const commit='740df936887f40efc727a24b159064bfd4db34e5';
 const historicalSchema=execFileSync('git',['show',`${commit}:src/db/schema.ts`],{encoding:'utf8'});
 const historicalClient=execFileSync('git',['show',`${commit}:src/db/client.ts`],{encoding:'utf8'});
 const sql=historicalSchema.match(/export const SQL_SCHEMA = `([\s\S]*?)`;/)?.[1]; assert.ok(sql);
 const templates=[...historicalClient.matchAll(/dbInstance!\.exec\(`([\s\S]*?)`\)/g)].map(m=>m[1]);
 const db=new Database(file); db.exec(sql); db.exec('ALTER TABLE upstream_accounts ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0');
 for(const name of ['DROP TRIGGER IF EXISTS upstream_credential_revision','DROP TRIGGER IF EXISTS upstream_state_revision','CREATE TABLE IF NOT EXISTS oauth_refresh_intents','CREATE TABLE IF NOT EXISTS user_daily_quota','CREATE TRIGGER IF NOT EXISTS protect_user_usage_history','CREATE TRIGGER IF NOT EXISTS protect_account_usage_history']) { const block=templates.find(s=>s.includes(name)); assert.ok(block,name); db.exec(block); }
 db.exec('INSERT INTO quota_migration_marker VALUES (1)'); db.close();
 const result=run(...flags,file); assert.equal(result.status,0,result.stderr);
}));
test('competing writer causes refusal without changing schema or journal mode', () => fixture(file=>{ create(file); const db=new Database(file); db.pragma('journal_mode = WAL'); const before=snapshot(file); db.exec('BEGIN IMMEDIATE'); try { const r=run(...flags,file); assert.notEqual(r.status,0); } finally { db.exec('ROLLBACK'); db.close(); } assert.deepEqual(snapshot(file),before); }));
test('missing quota marker is rejected without mutation', () => fixture(file=>{ create(file); const db=new Database(file); db.exec('DELETE FROM quota_migration_marker'); db.close(); const before=snapshot(file); const r=run(...flags,file); assert.notEqual(r.status,0); assert.deepEqual(snapshot(file),before); }));
test('upgraded synthetic database can initialize current client without losing legacy data', {skip: UPGRADE_DEFERRED}, () => fixture(file=>{ create(file); const before=snapshot(file); assert.equal(run(...flags,file).status,0); const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase()"],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'}}); assert.equal(r.status,0,r.stderr); const after=snapshot(file); assert.deepEqual(Object.fromEntries(Object.keys(before.rows).map(name=>[name,after.rows[name]])),before.rows); }));
