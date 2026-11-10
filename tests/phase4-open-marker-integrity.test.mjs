// ADR 0018 init fixture: inline startup children run db:init's provisioning first when the file is missing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
const init=file=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase} from './src/db/client.ts'; initDatabase()"],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'}});
for (const [name,mutation] of [
 ['marker removed', 'DROP TABLE ordinary_attempts_schema_marker'],
 ['marker row removed', 'DELETE FROM ordinary_attempts_schema_marker'],
 ['marker trigger', "CREATE TRIGGER marker_trigger BEFORE DELETE ON ordinary_attempts_schema_marker BEGIN SELECT RAISE(IGNORE); END"],
 ['incoming foreign key', 'CREATE TABLE danger(id TEXT REFERENCES ordinary_account_attempts(account_id) ON DELETE CASCADE)'],
 ['case collision', 'ALTER TABLE ordinary_attempts_schema_marker RENAME TO other; CREATE TABLE Ordinary_Attempts_Schema_Marker(id INTEGER)'],
]) test(`rejects ${name} and preserves OPEN`,()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'open-marker-')),file=path.join(dir,'db.sqlite');
 try {let child=init(file);assert.equal(child.status,0,child.stderr);let db=new Database(file);db.exec("INSERT INTO ordinary_account_attempts VALUES ('a','unknown'); "+mutation);const before=db.prepare('SELECT * FROM ordinary_account_attempts').all();db.close();
 child=init(file);assert.notEqual(child.status,0);assert.match(child.stdout+child.stderr,/Unsafe ordinary_account_attempts/);
 db=new Database(file,{readonly:true});assert.deepEqual(db.prepare('SELECT * FROM ordinary_account_attempts').all(),before);db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('nonempty unmarked legacy DB is refused unchanged',()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'open-legacy-')),file=path.join(dir,'db.sqlite');
 try {let db=new Database(file);db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('preserve')");db.close();const child=init(file);assert.notEqual(child.status,0);assert.match(child.stdout+child.stderr,/Unsafe 429 v2 schema/); /* ADR 0018: an unprovisioned legacy DB is refused at the v2 gate first */db=new Database(file,{readonly:true});assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema ORDER BY name").all().map(r=>r.name),['legacy'],'nothing was created');assert.equal(db.prepare('SELECT value FROM legacy').get().value,'preserve');db.close();}finally{rmSync(dir,{recursive:true,force:true})}
});
test('TEMP shadows and triggers are rejected on the active connection',async()=>{
 Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(process.env.TMPDIR,'never-opened.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
 const {validateOrdinaryProvisioning}=await import('../src/db/client.ts');
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'open-temp-')),file=path.join(dir,'db.sqlite');
 try {const child=init(file);assert.equal(child.status,0,child.stderr);const db=new Database(file);
 for(const sql of ['CREATE TEMP TABLE ordinary_account_attempts(x)', 'CREATE TEMP TABLE ordinary_attempts_schema_marker(x)', 'CREATE TEMP TRIGGER shadow BEFORE DELETE ON main.ordinary_account_attempts BEGIN SELECT RAISE(IGNORE); END']) {db.exec(sql);assert.throws(()=>validateOrdinaryProvisioning(db),/Unsafe ordinary_account_attempts/);db.exec('DROP TABLE IF EXISTS temp.ordinary_account_attempts; DROP TABLE IF EXISTS temp.ordinary_attempts_schema_marker; DROP TRIGGER IF EXISTS temp.shadow');}
 db.close();}finally{rmSync(dir,{recursive:true,force:true})}
});
