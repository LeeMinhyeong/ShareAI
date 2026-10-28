import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

test('credential generation migration is idempotent, preserves revisions and works with legacy rebuild', () => {
  for(const rebuild of [false,true]) for(const existing of [false,true]) {
    const dir=mkdtempSync(path.join(process.env.TMPDIR,'credential-revision-')), file=path.join(dir,'db.sqlite');
    try {
      let schema=rebuild?SQL_SCHEMA.replace(", 'oauth'",''):SQL_SCHEMA;
      if(!existing) schema=schema.replace('  credential_revision INTEGER NOT NULL DEFAULT 0,\n','');
      let db=new Database(file); db.exec(schema);
      db.prepare("INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at,state_revision) VALUES ('a','account','openai','api_key','key','active','2099-01-01',7)").run();
      if(existing) db.prepare('UPDATE upstream_accounts SET credential_revision=11 WHERE id=?').run('a');
      db.close();
      for(let i=0;i<2;i++) {
        const result=spawnSync(process.execPath,['--import','tsx','src/db/migrate.ts'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'}});
        assert.equal(result.status,0,result.stdout+result.stderr);
      }
      db=new Database(file);
      let row=db.prepare('SELECT state_revision,credential_revision FROM upstream_accounts WHERE id=?').get('a');
      assert.deepEqual(row,{state_revision:7,credential_revision:existing?11:0});
      db.prepare("UPDATE upstream_accounts SET last_error='note' WHERE id='a'").run();
      db.prepare("UPDATE upstream_accounts SET credentials=credentials WHERE id='a'").run();
      row=db.prepare('SELECT state_revision,credential_revision FROM upstream_accounts WHERE id=?').get('a');
      assert.deepEqual(row,{state_revision:8,credential_revision:existing?12:1});
      assert.deepEqual(db.pragma('foreign_key_check'),[]); db.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
});
