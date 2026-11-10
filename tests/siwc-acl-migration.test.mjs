import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';
import { UPGRADE_DEFERRED } from './helpers/upgrade-deferred.mjs';

test('legacy SIWC credentials and usage history survive repeatable private migration', {skip: UPGRADE_DEFERRED}, () => {
  const dir = mkdtempSync(join(process.env.LOCALAPPDATA,'hermes','cache','scratch','acl-migration-'));
  const file = join(dir,'fixture.db');
  let db = new Database(file);
  db.exec(SQL_SCHEMA);
  // Synthetic post-provisioning fixture only: these markers are not evidence
  // that a real legacy database is safe to upgrade.
  db.exec(`CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
    CREATE TABLE ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO ordinary_attempts_schema_marker VALUES(1,1);
    CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
    CREATE TABLE siwc_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO siwc_attempts_schema_marker VALUES(1,1);`);
  db.exec(`CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE siwc_credentials (id TEXT PRIMARY KEY,registration_key TEXT UNIQUE NOT NULL,credentials TEXT NOT NULL,revision TEXT NOT NULL);
    INSERT INTO siwc_accounts VALUES ('legacy','legacy');
    INSERT INTO siwc_credentials VALUES ('legacy','registration','synthetic-ciphertext','revision');
    INSERT INTO users(id,api_key_hash,name,email,tier) VALUES ('u','hash','user','user@example.invalid','free');
    INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('old','old','openai','api_key','synthetic-ciphertext','active','2030-01-01');
    INSERT INTO usage_logs(id,user_id,upstream_account_id,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES ('log','u','old','gpt-5','openai',0,0,1,7);`);
  db.close();
  const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const migration = new URL('../src/db/migrate.ts', import.meta.url).pathname.replace(/^\/(\w:)/,'$1');
  for (let i=0;i<2;i++) {
    const result = spawnSync(process.execPath,['--import',loader,decodeURIComponent(migration)],{cwd:dir,encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20)}});
    assert.equal(result.status,0,result.stderr);
  }
  db = new Database(file,{readonly:true});
  assert.deepEqual(db.prepare('SELECT * FROM siwc_credentials').get(),{id:'legacy',registration_key:'registration',credentials:'synthetic-ciphertext',revision:'revision'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_logs').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM siwc_access_policy').get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  db.close();
});
