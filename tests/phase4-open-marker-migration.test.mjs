// ADR 0018 init fixture: inline startup children run db:init's provisioning first when the file is missing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';

function init(file){return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase} from './src/db/client.ts'; initDatabase()"],{cwd:process.cwd(),encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'}})}
test('a missing provisioned OPEN table fails closed without changing other rows',()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'open-marker-')),file=path.join(dir,'db.sqlite');
 try {let child=init(file);assert.equal(child.status,0,child.stderr);let db=new Database(file);db.exec("INSERT INTO ordinary_account_attempts VALUES ('a','unknown'); CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserve'); DROP TABLE ordinary_account_attempts");db.close();
 child=init(file);assert.notEqual(child.status,0);assert.match(child.stderr+child.stdout,/Unsafe ordinary_account_attempts/);
 db=new Database(file,{readonly:true});assert.equal(db.prepare('SELECT value FROM sentinel').get().value,'preserve');assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='ordinary_account_attempts'").get(),undefined);db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
