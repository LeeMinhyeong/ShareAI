import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

test('migration preserves existing revisions and replaces the old trigger', () => {
  for (const rebuild of [false, true]) {
    const dir = mkdtempSync(path.join(process.env.TMPDIR, 'router-revision-upgrade-'));
    const file = path.join(dir, 'old.sqlite');
    try {
      let db = new Database(file);
      db.exec(rebuild ? SQL_SCHEMA.replace(", 'oauth'", '') : SQL_SCHEMA);
      db.prepare("INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at,state_revision) VALUES ('a','legacy','openai','api_key','key','active','2099-01-01',7)").run();
      db.exec('CREATE TRIGGER upstream_state_revision AFTER UPDATE OF status, last_error ON upstream_accounts BEGIN UPDATE upstream_accounts SET state_revision = state_revision + 1 WHERE id = NEW.id; END');
      db.close();
      for (let i = 0; i < 2; i++) {
        const result = spawnSync(process.execPath, ['--import','tsx','src/db/migrate.ts'], {cwd:process.cwd(),encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'}});
        assert.equal(result.status,0,result.stdout+result.stderr);
      }
      db = new Database(file);
      assert.equal(db.prepare('SELECT state_revision FROM upstream_accounts WHERE id = ?').get('a').state_revision,7);
      db.prepare("UPDATE upstream_accounts SET last_error='failure', request_revision=request_revision+1 WHERE id='a'").run();
      assert.equal(db.prepare('SELECT state_revision FROM upstream_accounts WHERE id = ?').get('a').state_revision,7);
      db.prepare("UPDATE upstream_accounts SET status='disabled' WHERE id='a'").run();
      assert.equal(db.prepare('SELECT state_revision FROM upstream_accounts WHERE id = ?').get('a').state_revision,8);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      db.close();
    } finally { rmSync(dir,{recursive:true,force:true}); }
  }
});

test('legacy database migration preserves accounts, logs and is idempotent', () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR, 'router-old-schema-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    let db = new Database(file);
    const oldSchema = SQL_SCHEMA.replace(", 'oauth'", '').replace('  state_revision INTEGER NOT NULL DEFAULT 0,\n', '');
    db.exec(oldSchema);
    db.prepare("INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','legacy','openai','api_key','original-key','active','2099-01-01')").run();
    db.prepare("INSERT INTO users(id,api_key_hash,name,email,tier) VALUES ('u','hash','user','e','free')").run();
    db.prepare("INSERT INTO usage_logs(id,user_id,upstream_account_id,model,provider,success,latency_ms) VALUES ('l','u','a','m','openai',1,1)").run();
    db.close();
    for (let i=0;i<2;i++) {
      const result = spawnSync(process.execPath, ['--import','tsx','src/db/migrate.ts'], {cwd:process.cwd(), encoding:'utf8', env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false'}});
      assert.equal(result.status,0,result.stdout+result.stderr);
    }
    db = new Database(file);
    assert.deepEqual(db.prepare('SELECT id,name,credentials,status,state_revision FROM upstream_accounts').get(), {id:'a',name:'legacy',credentials:'original-key',status:'active',state_revision:0});
    assert.equal(db.prepare('SELECT count(*) AS n FROM usage_logs WHERE upstream_account_id = ?').get('a').n,1);
    db.prepare("UPDATE upstream_accounts SET status='disabled' WHERE id='a'").run();
    db.prepare("UPDATE upstream_accounts SET status='active' WHERE id='a'").run();
    assert.equal(db.prepare('SELECT state_revision FROM upstream_accounts WHERE id = ?').get('a').state_revision,2);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
