import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {SQL_SCHEMA} from '../src/db/schema.ts';
import { UPGRADE_DEFERRED } from './helpers/upgrade-deferred.mjs';

test('repeat legacy migration adds defaults without rewriting SIWC credentials or usage', {skip: UPGRADE_DEFERRED}, ()=>{
 const dir=mkdtempSync(join(process.env.LOCALAPPDATA,'hermes','cache','scratch','routing-migration-')), file=join(dir,'fixture.db');
 let db=new Database(file); db.exec(SQL_SCHEMA);
 db.exec(`CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE siwc_credentials(id TEXT PRIMARY KEY,registration_key TEXT UNIQUE NOT NULL,credentials TEXT NOT NULL,revision TEXT NOT NULL);
 CREATE TABLE siwc_usage_logs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,timestamp TEXT NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,success INTEGER NOT NULL,aborted INTEGER NOT NULL,status INTEGER,latency_ms INTEGER NOT NULL);
 INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','synthetic-hash','u','u@example.invalid','free');
 INSERT INTO siwc_accounts VALUES('legacy','legacy'); INSERT INTO siwc_credentials VALUES('legacy','synthetic-registration','synthetic-ciphertext','revision');
 INSERT INTO siwc_usage_logs VALUES('log','u','legacy','2026-01-01T00:00:00.000Z','gpt','openai',1,2,1,0,200,10);`);
 const credential=db.prepare('SELECT * FROM siwc_credentials').get(), log=db.prepare('SELECT * FROM siwc_usage_logs').get(); db.close();
 const loader=new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url).href;
 const migration=decodeURIComponent(new URL('../src/db/migrate.ts',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
 for(let i=0;i<2;i++){const p=spawnSync(process.execPath,['--import',loader,migration],{cwd:dir,encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'synthetic-admin-key-for-testing'}});assert.equal(p.status,0,p.stderr)}
 db=new Database(file);
 try {
  assert.deepEqual(db.prepare('SELECT * FROM siwc_credentials').get(),credential); assert.deepEqual(db.prepare('SELECT * FROM siwc_usage_logs').get(),log);
  assert.deepEqual(db.prepare('SELECT COALESCE(r.priority,0) AS priority, COALESCE(r.weight,1) AS weight FROM siwc_accounts a LEFT JOIN siwc_routing_settings r ON a.id=r.account_id').get(),{priority:0,weight:1});
  db.prepare('INSERT INTO siwc_routing_settings(account_id) VALUES(?)').run('legacy'); assert.deepEqual(db.prepare('SELECT priority,weight FROM siwc_routing_settings').get(),{priority:0,weight:1});
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
 } finally {db.close()}
});
