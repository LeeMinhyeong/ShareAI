import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';

// ADR 0018: start from a provisioned database (attested safety schema incl. 429 v2), as db:init or
// the offline upgrader would leave it, so the specific legacy validator under test is reached; a
// legacy database without v2 is refused earlier, at the v2 gate.
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${path.join(process.env.TMPDIR, 'never-opened.sqlite')}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_LEVEL:'error', LOG_PRETTY:'false'});
const { provisionFreshDatabase } = await import('./helpers/fresh-db.mjs');
const canonical='CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL)';
for(const [name,sql] of [
 ['missing primary key','CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL, attempt_id TEXT NOT NULL)'],
 ['trigger',`${canonical}; CREATE TRIGGER deny BEFORE DELETE ON ordinary_account_attempts BEGIN SELECT RAISE(IGNORE); END`],
 ['extra index',`${canonical}; CREATE UNIQUE INDEX extra ON ordinary_account_attempts(attempt_id)`],
 ['view','CREATE VIEW ordinary_account_attempts AS SELECT 1 AS account_id']
]) test(`attempt migration rejects ${name} without mutation`,async ()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'attempt-migration-')),file=path.join(dir,'db.sqlite');
 try {await provisionFreshDatabase(file);let db=new Database(file);
   // Replace the provisioned table and marker with an unmarked, unsafe pre-existing relation.
   db.exec('DROP TABLE ordinary_account_attempts; DROP TABLE ordinary_attempts_schema_marker');db.exec(sql);const before=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();db.close();
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {initDatabase} from './src/db/client.ts'; initDatabase()"],{cwd:process.cwd(),encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'}});
  assert.notEqual(child.status,0);assert.match(child.stdout+child.stderr,/Unsafe ordinary_account_attempts/);
  db=new Database(file,{readonly:true});assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),before);assert.equal(db.pragma('journal_mode',{simple:true}),'delete');db.close();
 } finally {rmSync(dir,{recursive:true,force:true})}
});
