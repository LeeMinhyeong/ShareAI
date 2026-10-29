import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

test('legacy migration preserves custom account data, index and trigger', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'quota-migration-'));
  const file = join(dir, 'test.db');
  try {
    const db = new Database(file);
    db.exec(SQL_SCHEMA.replace("'cookie', 'api_key', 'session_token', 'oauth'", "'cookie', 'api_key', 'session_token'"));
    db.exec(`ALTER TABLE upstream_accounts ADD COLUMN custom_data TEXT;
      CREATE INDEX custom_account_data_idx ON upstream_accounts(custom_data);
      CREATE TRIGGER custom_account_update AFTER UPDATE ON upstream_accounts BEGIN SELECT 1; END;
      INSERT INTO upstream_accounts (id,name,provider,credential_type,credentials,status,quota_reset_at,custom_data)
      VALUES ('a','a','openai','api_key','preserved','active','2026-01-01','important');`);
    db.close();
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase();"], {
      cwd: process.cwd(), encoding: 'utf8', env: {...process.env, NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`,
        ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_LEVEL:'error', LOG_PRETTY:'false'}
    });
    // Refusing an unsafe migration is acceptable, provided the original data remains intact.
    assert.notEqual(child.status, null, child.stderr);
    const check = new Database(file, {readonly:true});
    try {
      assert.equal(check.prepare('SELECT custom_data FROM upstream_accounts WHERE id = ?').get('a').custom_data, 'important');
      const names = check.prepare("SELECT name FROM sqlite_master WHERE name IN ('custom_account_data_idx','custom_account_update') ORDER BY name").all().map(r => r.name);
      assert.deepEqual(names, ['custom_account_data_idx','custom_account_update']);
    } finally {check.close();}
  } finally {rmSync(dir, {recursive:true, force:true});}
});

for (const [label, customSql, checkSql, expected] of [
  ['column', 'ALTER TABLE upstream_accounts ADD COLUMN custom_data TEXT; UPDATE upstream_accounts SET custom_data = \'important\'', 'SELECT custom_data AS value FROM upstream_accounts', 'important'],
  ['index', 'CREATE INDEX custom_account_idx ON upstream_accounts(credentials)', "SELECT sql AS value FROM sqlite_master WHERE name = 'custom_account_idx'", 'CREATE INDEX custom_account_idx ON upstream_accounts(credentials)'],
  ['quoted index name', 'CREATE INDEX "evil; DROP TABLE users; --" ON upstream_accounts(credentials)', 'SELECT count(*) AS value FROM users', 0],
  ['trigger', 'CREATE TRIGGER custom_account_trigger AFTER UPDATE ON upstream_accounts BEGIN SELECT 1; END', "SELECT sql AS value FROM sqlite_master WHERE name = 'custom_account_trigger'", 'CREATE TRIGGER custom_account_trigger AFTER UPDATE ON upstream_accounts BEGIN SELECT 1; END'],
  ['constraint', '', 'SELECT credentials AS value FROM upstream_accounts', 'preserved'],
  ['generated column', 'ALTER TABLE upstream_accounts ADD COLUMN custom_generated TEXT GENERATED ALWAYS AS (credentials) VIRTUAL', 'SELECT custom_generated AS value FROM upstream_accounts', 'preserved'],
]) {
  test(`unsafe legacy ${label} fails closed and rolls back all changes`, () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'quota-migration-rollback-'));
    const file = join(dir, 'test.db');
    try {
      let db = new Database(file);
      let schema = SQL_SCHEMA.replace(", 'oauth'", '').replace('  meta TEXT,\n', '').replace('  quota_info TEXT,\n', '');
      if (label === 'constraint') schema = schema.replace('credentials TEXT NOT NULL,', "credentials TEXT NOT NULL CHECK (length(credentials) > 0),");
      db.exec(schema);
      db.exec("INSERT INTO upstream_accounts (id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','a','openai','api_key','preserved','active','2026-01-01')");
      if (customSql) db.exec(customSql);
      const before = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
      db.close();
      const child = spawnSync(process.execPath, ['--import','tsx','src/db/migrate.ts'], {
        cwd: process.cwd(), encoding: 'utf8', env: {...process.env, NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`,
          ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_PRETTY:'false'}
      });
      assert.notEqual(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout + child.stderr, /unsafe legacy.*upstream_accounts/i);
      db = new Database(file, {readonly:true});
      try {
        assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all(), before);
        assert.equal(db.prepare(checkSql).get().value, expected);
        assert.equal(db.prepare('SELECT credentials FROM upstream_accounts').get().credentials, 'preserved');
      } finally { db.close(); }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
}
