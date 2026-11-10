import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

// ADR 0018: databases are created only by db:init. These fixtures start from a provisioned
// database (attested safety schema, including 429 v2) so the cooldown validator itself is
// exercised; a legacy database without v2 is refused earlier, at the v2 gate.
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${join(process.env.TMPDIR, 'never-opened.sqlite')}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_LEVEL:'error', LOG_PRETTY:'false'});
const { provisionFreshDatabase } = await import('./helpers/fresh-db.mjs');

const canonical = `CREATE TABLE account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`;
function initialize(file) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase();"], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    env: {...process.env, NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`,
      ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_LEVEL:'error', LOG_PRETTY:'false'}
  });
}
for (const [label, sql] of [
  ['missing primary key', canonical.replace('PRIMARY KEY(kind, account_id)', 'CHECK(kind <> \'\')')],
  ['missing revision constraint', canonical.replace(' CHECK(revision > 0)', '')],
  ['nullable deadline', canonical.replace('until_at INTEGER NOT NULL', 'until_at INTEGER')],
  ['reversed primary key', canonical.replace('PRIMARY KEY(kind, account_id)', 'PRIMARY KEY(account_id, kind)')],
  ['altered check', canonical.replace('revision > 0', 'revision >= 0')],
  ['additional generated column', canonical.replace('  PRIMARY KEY', '  extra TEXT GENERATED ALWAYS AS (kind) VIRTUAL,\n  PRIMARY KEY')],
  ['additional unique index', `${canonical}; CREATE UNIQUE INDEX extra_cooldown_index ON account_429_cooldowns(until_at)`],
  ['write blocking trigger', `${canonical}; CREATE TRIGGER deny_cooldown BEFORE UPDATE ON account_429_cooldowns BEGIN SELECT RAISE(IGNORE); END`],
]) {
  test(`incompatible cooldown ${label} fails initialization without changing data or schema`, async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'cooldown-migration-'));
    const file = join(dir, 'test.db');
    try {
      await provisionFreshDatabase(file);
      let db = new Database(file);
      assert.equal(db.pragma('journal_mode = DELETE', {simple:true}), 'delete');
      db.exec(sql);
      db.prepare('INSERT INTO account_429_cooldowns VALUES (?, ?, ?, ?, ?)').run('upstream', 'old', 1, 2, 1);
      const before = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
      db.close();
      const child = initialize(file);
      assert.notEqual(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout + child.stderr, /unsafe.*account_429_cooldowns/i);
      db = new Database(file, {readonly:true});
      try {
        assert.equal(db.pragma('journal_mode', {simple:true}), 'delete');
        assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(), before);
        assert.deepEqual(db.prepare('SELECT kind, account_id, observed_at, until_at, revision FROM account_429_cooldowns').all(), [{kind:'upstream', account_id:'old', observed_at:1, until_at:2, revision:1}]);
      } finally { db.close(); }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
}

test('TEMP name and trigger conflicts fail without touching the main database', async () => {
  Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:',
    ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_LEVEL:'error', LOG_PRETTY:'false'});
  const { migrateAccount429Cooldowns } = await import('../src/db/client.ts');
  const dir = mkdtempSync(join(process.env.TMPDIR, 'cooldown-temp-'));
  const file = join(dir, 'test.db');
  try {
    const db = new Database(file);
    try {
      db.exec(canonical);
      db.exec("INSERT INTO main.account_429_cooldowns VALUES ('upstream','old',1,2,1)");
      db.exec('CREATE TEMP TABLE account_429_cooldowns (id TEXT)');
      assert.throws(() => db.transaction(() => migrateAccount429Cooldowns(db)).immediate(), /unsafe.*TEMP/i);
      db.exec('DROP TABLE temp.account_429_cooldowns');
      db.exec('CREATE TEMP TRIGGER deny_temp BEFORE UPDATE ON main.account_429_cooldowns BEGIN SELECT RAISE(IGNORE); END');
      assert.throws(() => db.transaction(() => migrateAccount429Cooldowns(db)).immediate(), /unsafe.*TEMP/i);
      assert.equal(db.prepare('SELECT until_at FROM main.account_429_cooldowns').get().until_at, 2);
    } finally { db.close(); }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('fresh cooldown schema is created and can reopen with its rows intact', async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'cooldown-migration-'));
  const file = join(dir, 'test.db');
  try {
    await provisionFreshDatabase(file); // what db:init does before the first start
    let child = initialize(file);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const db = new Database(file);
    assert.equal(db.pragma('journal_mode', {simple:true}), 'wal');
    db.prepare('INSERT INTO account_429_cooldowns VALUES (?, ?, ?, ?, ?)').run('upstream', 'old', 1, 2, 1);
    db.close();
    child = initialize(file);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const check = new Database(file, {readonly:true});
    try { assert.equal(check.prepare('SELECT until_at FROM account_429_cooldowns').get().until_at, 2); }
    finally { check.close(); }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
