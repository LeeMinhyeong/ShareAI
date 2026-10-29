import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

test('a late legacy success is not included by a second migration', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'quota-offline-cutover-'));
  const file = join(dir, 'fixture.db');
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: `sqlite:${file}`,
    ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'test-admin-key-'.repeat(3),
    LOG_LEVEL: 'error', LOG_PRETTY: 'false' };
  const migrate = () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    let db = new Database(file);
    db.exec(SQL_SCHEMA);
    db.exec(`INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit)
      VALUES ('u','hash','fixture','fixture@test.invalid','free',10);
      INSERT INTO upstream_accounts (id,name,provider,credential_type,credentials,status,quota_reset_at)
      VALUES ('a','fixture','openai','api_key','fixture','active','2099-01-01');
      INSERT INTO usage_logs (id,user_id,upstream_account_id,timestamp,model,provider,success,latency_ms)
      VALUES ('before','u','a','2026-01-01T12:00:00Z','test','openai',1,1);`);
    db.close();
    migrate();
    db = new Database(file);
    assert.equal(db.prepare("SELECT used FROM user_daily_quota WHERE user_id='u' AND day='2026-01-01'").get().used, 1);
    // Simulate a legacy writer that only appends its success log after the seed.
    db.exec(`INSERT INTO usage_logs (id,user_id,upstream_account_id,timestamp,model,provider,success,latency_ms)
      VALUES ('late','u','a','2026-01-01T13:00:00Z','test','openai',1,1)`);
    db.close();
    migrate();
    db = new Database(file, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_logs WHERE user_id='u' AND success=1").get().n, 2);
      assert.equal(db.prepare("SELECT used FROM user_daily_quota WHERE user_id='u' AND day='2026-01-01'").get().used, 1);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
