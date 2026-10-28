import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

test('simultaneous legacy migrations preserve accounts and references', {timeout:60000}, async () => {
  for (const rebuild of [false,true]) for (let round=0;round<3;round++) {
    const dir=mkdtempSync(path.join(process.env.TMPDIR,'router-concurrent-migrate-')); const file=path.join(dir,'old.db');
    try {
      let db=new Database(file);
      let schema=SQL_SCHEMA.replace('  meta TEXT,\n','').replace('  quota_info TEXT,\n','').replace('  state_revision INTEGER NOT NULL DEFAULT 0,\n','').replace('  request_revision INTEGER NOT NULL DEFAULT 0,\n','');
      if (rebuild) schema=schema.replace(", 'oauth'",'');
      db.exec(schema);
      db.exec("INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','legacy','openai','api_key','key','active','2099-01-01'); INSERT INTO users(id,api_key_hash,name,email,tier) VALUES ('u','hash','user','e','free'); INSERT INTO usage_logs(id,user_id,upstream_account_id,model,provider,success,latency_ms) VALUES ('l','u','a','m','openai',1,1)");
      db.pragma('journal_mode = WAL'); db.exec('BEGIN IMMEDIATE');
      const children=Array.from({length:8},()=>fork(new URL('./migration-barrier-child.mjs',import.meta.url),[],{cwd:process.cwd(),execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'}}));
      const errors=children.map(()=> ''); children.forEach((p,i)=>p.stderr.on('data',d=>errors[i]+=d));
      try {
        assert.deepEqual(await Promise.all(children.map(p=>once(p,'message').then(([m])=>m))),Array(8).fill('ready'));
        const attempted=children.map(p=>once(p,'message').then(([m])=>m));
        const exits=children.map(p=>once(p,'exit').then(([code])=>code));
        children.forEach(p=>p.send('go'));
        assert.deepEqual(await Promise.all(attempted),Array(8).fill('attempting'));
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.ok(children.every(p=>p.exitCode===null),'all migrators must overlap while the database write lock is held');
        db.exec('COMMIT'); db.close();
        assert.deepEqual(await Promise.all(exits),Array(8).fill(0),errors.join('\n'));
      } finally {for(const p of children) if(p.exitCode===null) p.kill(); if(db.open) db.close();}
      db=new Database(file); assert.equal(db.prepare('SELECT credentials FROM upstream_accounts WHERE id=?').get('a').credentials,'key'); assert.equal(db.prepare('SELECT count(*) n FROM usage_logs WHERE upstream_account_id=?').get('a').n,1); assert.deepEqual(db.pragma('foreign_key_check'),[]); assert.equal(db.pragma('integrity_check',{simple:true}),'ok'); db.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
