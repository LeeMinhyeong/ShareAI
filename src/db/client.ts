/**
 * SQLite 데이터베이스 클라이언트
 */
import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { SQL_SCHEMA, assertTokenUsageSchema } from './schema.js';
import { SiwcStore } from '../upstream/siwc-store.js';
import { assert429V2Schema, provision429V2 } from './account-429-v2-store.js';

// ADR 0018: databases are created only by `npm run db:init`; in-memory SQLite is unsupported.
export const IN_MEMORY_UNSUPPORTED = 'In-memory SQLite and file: URIs are not supported; use a plain file path created with npm run db:init (ADR 0018)';
export function isInMemoryPath(dbPath: string): boolean {
  // `file:` forms are refused outright: in-memory URIs, and on Windows `file:x` names an alternate data stream.
  return dbPath === ':memory:' || /^file:/i.test(dbPath) || /[?&]mode=memory(&|$)/i.test(dbPath);
}

let dbInstance: Database.Database | null = null;
// A failed close retains the handle but never publishes it. Only explicit
// shutdown can resolve quarantine; successful initialization cleanup may retry.
let state: 'idle' | 'initializing' | 'initialized' | 'closing' | 'quarantined' | 'closed' = 'idle';
let closeRequested = false;

/**
 * SQLite DB 초기화
 */
export function initDatabase(): Database.Database {
  if (state === 'initialized') return requireInitializedDatabase();
  if (state !== 'idle') throw new Error(`Database is ${state}`);

  state = 'initializing';
  closeRequested = false;
  const checkClose = () => { if (closeRequested) throw new Error('Database is closing'); };
  try {

    // DATABASE_URL에서 파일 경로 추출 (sqlite:./data/router.db)
    const dbPath = env.DATABASE_URL.replace('sqlite:', '');
    // ADR 0018: an in-memory database is always empty and can never carry the attested safety schema.
    if (isInMemoryPath(dbPath)) throw new Error(IN_MEMORY_UNSUPPORTED);


    logger.info({ dbPath }, 'Initializing SQLite database');
    checkClose();

    // A contending writer must fail in bounded time rather than stall indefinitely.
    // Never create a database or directory: missing v2 cannot attest freshness.
    dbInstance = new Database(dbPath, { timeout: 5000, fileMustExist: true });
    checkClose();
    assert429V2Schema(dbInstance);
    assertTokenUsageSchema(dbInstance, true);
    checkClose();
    // Read-only preflight avoids changing persistent journal mode for an existing
    // collision. SQLite cannot change journal mode inside the write transaction:
    // another connection can change the schema between this check and WAL, so
    // this is not a guarantee against journal-mode changes in that race.
    validateAccount429Cooldowns(dbInstance);
    checkClose();
    validateOrdinaryProvisioning(dbInstance);
    checkClose();
    validateSiwcProvisioning(dbInstance);
    checkClose();
    dbInstance.pragma('journal_mode = WAL');
    checkClose();
    // The refresh intent must survive a power loss before the provider is called.
    dbInstance.pragma('synchronous = FULL');
    checkClose();

    // Foreign keys must be disabled before the transaction for the legacy rebuild.
    // Hold one write lock across schema creation, discovery, and every migration.
    dbInstance.pragma('foreign_keys = OFF');
    checkClose();
    dbInstance.transaction(() => {
      // Recheck after acquiring the actual writer before any transactional write.
      assert429V2Schema(dbInstance!);
      // Check before provisioning or CREATE TABLE IF NOT EXISTS can recreate
      // an established database's missing usage history under the writer lock.
      assertTokenUsageSchema(dbInstance!, true);
      checkClose();
      const provisionOrdinary = !validateOrdinaryProvisioning(dbInstance!);
      const provisionSiwc = !validateSiwcProvisioning(dbInstance!);
      if (provisionOrdinary) {
        dbInstance!.exec(ORDINARY_ATTEMPTS_SQL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
        dbInstance!.exec(ORDINARY_MARKER_SQL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
        dbInstance!.exec('INSERT INTO main.ordinary_attempts_schema_marker VALUES (1, 1)');
      }
      if (provisionSiwc) {
        dbInstance!.exec(SIWC_ATTEMPTS_SQL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
        dbInstance!.exec(SIWC_MARKER_SQL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
        dbInstance!.exec('INSERT INTO main.siwc_attempts_schema_marker VALUES (1, 1)');
      }
      dbInstance!.exec(SQL_SCHEMA);
      assertTokenUsageSchema(dbInstance!);
      migrate(dbInstance!);
      SiwcStore.initialize(dbInstance!);
      const cols = dbInstance!.prepare('PRAGMA table_info(upstream_accounts)').all() as { name: string }[];
      if (!cols.some(c => c.name === 'state_revision')) dbInstance!.exec('ALTER TABLE upstream_accounts ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0');
      if (!cols.some(c => c.name === 'request_revision')) dbInstance!.exec('ALTER TABLE upstream_accounts ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0');
      if (!cols.some(c => c.name === 'credential_revision')) dbInstance!.exec('ALTER TABLE upstream_accounts ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0');
      if (!cols.some(c => c.name === 'last_refresh_revision')) dbInstance!.exec('ALTER TABLE upstream_accounts ADD COLUMN last_refresh_revision INTEGER NOT NULL DEFAULT -1');
      dbInstance!.exec(`DROP TRIGGER IF EXISTS upstream_credential_revision;
        CREATE TRIGGER upstream_credential_revision AFTER UPDATE OF credentials, credential_type ON upstream_accounts
        BEGIN UPDATE upstream_accounts SET credential_revision = credential_revision + 1 WHERE id = NEW.id; END`);
      // Replace the old trigger atomically. Request results advance their own revision.
      dbInstance!.exec(`DROP TRIGGER IF EXISTS upstream_state_revision;
        CREATE TRIGGER upstream_state_revision AFTER UPDATE OF status, last_error ON upstream_accounts
        WHEN NEW.request_revision = OLD.request_revision
        BEGIN UPDATE upstream_accounts SET state_revision = state_revision + 1 WHERE id = NEW.id; END`);
      // Separate additive policy tables preserve legacy SIWC records unchanged.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS siwc_access_policy (
        account_id TEXT PRIMARY KEY REFERENCES siwc_accounts(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        scope TEXT NOT NULL CHECK(scope IN ('all','selected'))
      );
      CREATE TABLE IF NOT EXISTS siwc_access_users (
        account_id TEXT NOT NULL REFERENCES siwc_access_policy(account_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(account_id, user_id)
      );`);
      // Defaults are implicit for legacy accounts; credentials and history stay untouched.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS siwc_routing_settings (
        account_id TEXT PRIMARY KEY REFERENCES siwc_accounts(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL DEFAULT 0 CHECK(typeof(priority)='integer' AND priority BETWEEN 0 AND 1000),
        weight INTEGER NOT NULL DEFAULT 1 CHECK(typeof(weight)='integer' AND weight BETWEEN 1 AND 100)
      );`);
      // Additive history; neither account nor user deletion may cascade it.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS siwc_usage_logs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        account_id TEXT NOT NULL REFERENCES siwc_accounts(id), timestamp TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
        success INTEGER NOT NULL CHECK(success IN (0,1)), aborted INTEGER NOT NULL CHECK(aborted IN (0,1)),
        status INTEGER, latency_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_siwc_usage_user_timestamp ON siwc_usage_logs(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_siwc_usage_account_timestamp ON siwc_usage_logs(account_id, timestamp DESC);`);
      // Never expire intents: an interrupted exchange has an unknowable outcome.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS oauth_refresh_intents (
        token_fingerprint TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      // Stable account identity, independent of credential and request revisions.
      migrateAccount429Cooldowns(dbInstance!);
      validateOrdinaryProvisioning(dbInstance!);
      validateSiwcProvisioning(dbInstance!);
      // A single bounded row per account; legacy usage is unknowable on cutover day.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS account_daily_reservations (
        account_id TEXT PRIMARY KEY REFERENCES upstream_accounts(id) ON DELETE CASCADE,
        day TEXT NOT NULL, used INTEGER NOT NULL CHECK(typeof(used)='integer' AND used >= 0),
        legacy_ambiguous INTEGER NOT NULL CHECK(legacy_ambiguous IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS account_quota_migration_marker (id INTEGER PRIMARY KEY CHECK(id=1));`);
      if (!dbInstance!.prepare('SELECT 1 FROM account_quota_migration_marker WHERE id=1').get()) {
        dbInstance!.prepare(`INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous)
          SELECT id, ?, 0, 1 FROM upstream_accounts`).run(new Date().toISOString().slice(0,10));
        dbInstance!.exec('INSERT INTO account_quota_migration_marker VALUES (1)');
      }
      // Seed once from legacy successes; later completion logs are already covered by reservations.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS user_daily_quota (
        user_id TEXT NOT NULL REFERENCES users(id),
        day TEXT NOT NULL,
        used INTEGER NOT NULL CHECK (used >= 0),
        PRIMARY KEY (user_id, day)
      );
      CREATE TABLE IF NOT EXISTS quota_migration_marker (id INTEGER PRIMARY KEY CHECK (id = 1));`);
      const seeded = dbInstance!.prepare('SELECT 1 FROM quota_migration_marker WHERE id = 1').get();
      if (!seeded) {
        if (dbInstance!.prepare("SELECT 1 FROM usage_logs WHERE success = 1 AND strftime('%Y-%m-%d', timestamp) IS NULL LIMIT 1").get()) {
          throw new Error('Cannot migrate usage history with invalid timestamps');
        }
        dbInstance!.exec(`INSERT INTO user_daily_quota (user_id, day, used)
          SELECT user_id, strftime('%Y-%m-%d', timestamp), COUNT(*) FROM usage_logs
          WHERE success = 1 AND strftime('%Y-%m-%d', timestamp) IS NOT NULL
          GROUP BY user_id, strftime('%Y-%m-%d', timestamp);
          INSERT INTO quota_migration_marker (id) VALUES (1);`);
      }
      dbInstance!.exec(`CREATE TRIGGER IF NOT EXISTS protect_user_usage_history
        BEFORE DELETE ON users
        WHEN EXISTS (SELECT 1 FROM usage_logs WHERE user_id = OLD.id)
          OR EXISTS (SELECT 1 FROM user_daily_quota WHERE user_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'user has usage history'); END`);
      // Keep history even for direct SQL deletes, including old databases whose
      // usage_logs foreign key previously specified ON DELETE CASCADE.
      dbInstance!.exec(`CREATE TRIGGER IF NOT EXISTS protect_account_usage_history
        BEFORE DELETE ON upstream_accounts
        WHEN EXISTS (SELECT 1 FROM usage_logs WHERE upstream_account_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'account has usage history'); END`);
      // The transaction wrapper commits only after this callback returns.
      checkClose();
    }).immediate();
    dbInstance.pragma('foreign_keys = ON');
    logger.info('Database initialized successfully');
    checkClose();
  } catch (error) {
    try {
      if (dbInstance) {
        dbInstance.close();
        if (dbInstance.open) throw new Error('Database cleanup did not close connection');
      }
    } catch (cleanupError) {
      state = 'quarantined';
      throw new AggregateError([error, cleanupError], 'Database initialization and cleanup failed');
    }
    dbInstance = null;
    state = closeRequested ? 'closed' : 'idle';
    throw error;
  }
  state = 'initialized';
  return dbInstance;
}

const COOLDOWN_TABLE_SQL = `CREATE TABLE account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`;

// No expiry: a process death leaves the provider outcome unknowable.
const ORDINARY_ATTEMPTS_SQL = `CREATE TABLE ordinary_account_attempts (
  account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
)`;
const ORDINARY_MARKER_SQL = `CREATE TABLE ordinary_attempts_schema_marker (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
)`;
const SIWC_ATTEMPTS_SQL = `CREATE TABLE siwc_account_attempts (
  account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
)`;
const SIWC_MARKER_SQL = `CREATE TABLE siwc_attempts_schema_marker (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
)`;

// Caller must own a top-level IMMEDIATE transaction and attest pristine provenance.
// A schema check cannot establish provenance or transaction ownership.
export function provisionFreshSafetySchema(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('Fresh provisioning requires a caller-owned transaction');
  const databases = db.pragma('database_list') as {name: string}[];
  if (databases.some(entry => entry.name !== 'main' && entry.name !== 'temp') ||
      db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get() ||
      db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) {
    throw new Error('Fresh provisioning requires an empty, unattached database');
  }
  for (const sql of [ORDINARY_ATTEMPTS_SQL, ORDINARY_MARKER_SQL, SIWC_ATTEMPTS_SQL, SIWC_MARKER_SQL]) {
    db.exec(sql.replace('CREATE TABLE ', 'CREATE TABLE main.'));
  }
  db.exec('INSERT INTO main.ordinary_attempts_schema_marker VALUES (1, 1); INSERT INTO main.siwc_attempts_schema_marker VALUES (1, 1)');
  provision429V2(db);
  if (!validateOrdinaryProvisioning(db) || !validateSiwcProvisioning(db)) throw new Error('Fresh provisioning validation failed');
  assert429V2Schema(db);
}

export function validateSiwcProvisioning(db: Database.Database): boolean {
  const names = ['siwc_account_attempts', 'siwc_attempts_schema_marker'];
  const unsafe = (): never => { throw new Error('Unsafe SIWC attempt schema; offline inspection required'); };
  const tokenize = (sql: string) => {
    if (sql.replace(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),=]|\s+/g, '') !== '') return null;
    return JSON.stringify(sql.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),=]/g));
  };
  for (const name of names) {
    if (db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name=? COLLATE NOCASE OR (type='trigger' AND tbl_name=? COLLATE NOCASE)").get(name,name)) unsafe();
  }
  for (const schema of ['main','temp']) {
    for (const table of db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table'`).all() as {name:string}[]) {
      const quoted = `"${table.name.replace(/"/g, '""')}"`;
      if ((db.prepare(`PRAGMA ${schema}.foreign_key_list(${quoted})`).all() as {table:string}[]).some(fk => names.includes(fk.table.toLowerCase()))) unsafe();
    }
  }
  const objects = names.map(name => db.prepare('SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE').get(name) as {type:string;name:string;sql:string} | undefined);
  if (!objects[0] && !objects[1]) {
    if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) unsafe();
    return false;
  }
  for (let i=0; i<names.length; i++) {
    const object = objects[i];
    if (!object || object.type !== 'table' || object.name !== names[i] || !object.sql || tokenize(object.sql) !== tokenize(i === 0 ? SIWC_ATTEMPTS_SQL : SIWC_MARKER_SQL)) unsafe();
    if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE tbl_name=? COLLATE NOCASE AND (type='trigger' OR (type='index' AND sql IS NOT NULL))").get(names[i])) unsafe();
  }
  const indexes = db.prepare('PRAGMA main.index_list(siwc_account_attempts)').all() as {name:string;unique:number;origin:string;partial:number}[];
  if (indexes.length !== 1 || indexes[0].name !== 'sqlite_autoindex_siwc_account_attempts_1' || indexes[0].unique !== 1 || indexes[0].origin !== 'pk' || indexes[0].partial !== 0) unsafe();
  const keys = (db.prepare('PRAGMA main.index_xinfo(sqlite_autoindex_siwc_account_attempts_1)').all() as {name:string;key:number;desc:number;coll:string}[]).filter(k => k.key === 1);
  if (keys.length !== 1 || keys[0].name !== 'account_id' || keys[0].desc !== 0 || keys[0].coll !== 'BINARY') unsafe();
  const rows = db.prepare('SELECT id,version FROM main.siwc_attempts_schema_marker').all() as {id:number;version:number}[];
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== 1) unsafe();
  return true;
}

// A missing pair is safe to provision only in a genuinely empty database.
// No in-band bit can distinguish a legacy DB from deletion of both objects.
export function validateOrdinaryProvisioning(db: Database.Database): boolean {
  const name = 'ordinary_attempts_schema_marker';
  const unsafe = (): never => { throw new Error('Unsafe ordinary_account_attempts provisioning or marker; offline inspection required'); };
  const attempts = validateOrdinaryAttempts(db);
  if (db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name=? COLLATE NOCASE OR (type='trigger' AND tbl_name=? COLLATE NOCASE)").get(name,name)) unsafe();
  const marker = db.prepare('SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE').get(name) as {type:string;name:string;sql:string} | undefined;
  // Other tables must not be able to cascade into either safety table.
  for (const schema of ['main', 'temp']) {
    const tables = db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table'`).all() as {name:string}[];
    for (const table of tables) {
      const quoted = `"${table.name.replace(/"/g, '""')}"`;
      const foreignKeys = db.prepare(`PRAGMA ${schema}.foreign_key_list(${quoted})`).all() as {table:string}[];
      if (foreignKeys.some(fk => ['ordinary_account_attempts', name].includes(fk.table.toLowerCase()))) unsafe();
    }
  }
  if (!marker) {
    if (attempts || db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) unsafe();
    return false;
  }
  const tokenize = (sql: string) => JSON.stringify(sql.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),=]/g));
  if (!attempts || marker.type !== 'table' || marker.name !== name || !marker.sql ||
      tokenize(marker.sql) !== tokenize(ORDINARY_MARKER_SQL) ||
      marker.sql.replace(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),=]|\s+/g,'') !== '') unsafe();
  if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE tbl_name=? COLLATE NOCASE AND (type='trigger' OR type='index')").get(name)) unsafe();
  const rows = db.prepare('SELECT id,version FROM main.ordinary_attempts_schema_marker').all() as {id:number;version:number}[];
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== 1) unsafe();
  return true;
}
function validateOrdinaryAttempts(db: Database.Database): boolean {
  const name = 'ordinary_account_attempts';
  const unsafe = (): never => { throw new Error('Unsafe ordinary_account_attempts schema; manual inspection required'); };
  if (db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name=? COLLATE NOCASE OR (type='trigger' AND tbl_name=? COLLATE NOCASE)").get(name,name)) unsafe();
  const object = db.prepare('SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE').get(name) as {type:string;name:string;sql:string} | undefined;
  if (!object) return false;
  const tokens = (sql: string) => JSON.stringify(sql.match(/[A-Za-z_][A-Za-z_0-9]*|[(),]/g));
  if (object.type !== 'table' || object.name !== name || !object.sql || tokens(object.sql) !== tokens(ORDINARY_ATTEMPTS_SQL) || object.sql.replace(/[A-Za-z_][A-Za-z_0-9]*|[(),]|\s+/g,'') !== '') unsafe();
  if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE tbl_name=? COLLATE NOCASE AND (type='trigger' OR (type='index' AND sql IS NOT NULL))").get(name)) unsafe();
  const indexes = db.prepare('PRAGMA main.index_list(ordinary_account_attempts)').all() as {name:string;unique:number;origin:string;partial:number}[];
  if (indexes.length !== 1 || indexes[0].name !== 'sqlite_autoindex_ordinary_account_attempts_1' || indexes[0].unique !== 1 || indexes[0].origin !== 'pk' || indexes[0].partial !== 0) unsafe();
  const keys = (db.prepare('PRAGMA main.index_xinfo(sqlite_autoindex_ordinary_account_attempts_1)').all() as {name:string;key:number;desc:number;coll:string}[]).filter(k => k.key === 1);
  if (keys.length !== 1 || keys[0].name !== 'account_id' || keys[0].desc !== 0 || keys[0].coll !== 'BINARY') unsafe();
  return true;
}

/** Revalidate under the initialization writer before creating an absent table. */
export function migrateAccount429Cooldowns(db: Database.Database): void {
  if (!validateAccount429Cooldowns(db)) db.exec(COOLDOWN_TABLE_SQL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
}

/** Read-only validation; returns false if no cooldown object exists. */
function validateAccount429Cooldowns(db: Database.Database): boolean {
  const unsafe = (reason: string): never => {
    throw new Error(`Unsafe account_429_cooldowns schema: ${reason}; manual inspection required`);
  };
  const temp = db.prepare(`SELECT type, name FROM temp.sqlite_schema
    WHERE name = 'account_429_cooldowns' COLLATE NOCASE
       OR (type = 'trigger' AND tbl_name = 'account_429_cooldowns' COLLATE NOCASE)`).all();
  if (temp.length) unsafe('conflicting TEMP object');
  const object = db.prepare(`SELECT type, name, sql FROM main.sqlite_schema
    WHERE name = 'account_429_cooldowns' COLLATE NOCASE`).get() as
      { type: string; name: string; sql: string | null } | undefined;
  if (!object) return false;
  {
    // Compare tokens rather than ignoring all whitespace (NOT NULL is not NOTNULL).
    // Quoting, comments and alternate spellings deliberately fail closed.
    const tokenize = (sql: string): string | null => {
      const tokens = sql.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),>]/g);
      if (!tokens || sql.replace(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),>]|\s+/g, '') !== '') return null;
      return JSON.stringify(tokens);
    };
    if (object.type !== 'table' || !object.sql || tokenize(object.sql) !== tokenize(COOLDOWN_TABLE_SQL)) {
      unsafe('unrecognized table definition or name conflict');
    }
  }
  const extras = db.prepare(`SELECT type, name FROM main.sqlite_schema
    WHERE tbl_name = 'account_429_cooldowns' COLLATE NOCASE
      AND (type = 'trigger' OR (type = 'index' AND sql IS NOT NULL))`).all();
  if (extras.length) unsafe('unexpected index or trigger');
  const indexes = db.prepare('PRAGMA main.index_list(account_429_cooldowns)').all() as
    { name: string; unique: number; origin: string; partial: number }[];
  if (indexes.length !== 1 || indexes[0].name !== 'sqlite_autoindex_account_429_cooldowns_1' ||
      indexes[0].unique !== 1 || indexes[0].origin !== 'pk' || indexes[0].partial !== 0) unsafe('unexpected primary key index');
  const keys = db.prepare('PRAGMA main.index_xinfo(sqlite_autoindex_account_429_cooldowns_1)').all() as
    { name: string | null; key: number; desc: number; coll: string }[];
  const indexed = keys.filter(k => k.key === 1);
  if (indexed.length !== 2 || indexed[0].name !== 'kind' || indexed[1].name !== 'account_id' ||
      indexed.some(k => k.desc !== 0 || k.coll !== 'BINARY')) unsafe('unexpected primary key columns');
  return true;
}

/**
 * 기존 DB 마이그레이션
 * - upstream_accounts: credential_type CHECK에 'oauth' 추가 (SQLite는 CHECK 변경 불가 → 테이블 재생성)
 * - meta, quota_info 컬럼 추가
 */
function migrate(db: Database.Database): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'upstream_accounts'")
    .get() as { sql: string } | undefined;
  if (!table) return;

  const cols = (db.prepare('PRAGMA table_info(upstream_accounts)').all() as { name: string }[]).map(c => c.name);
  if (!table.sql.includes("'oauth'")) assertSafeLegacyRebuild(db, table.sql, cols);
  if (!cols.includes('meta')) db.exec('ALTER TABLE upstream_accounts ADD COLUMN meta TEXT');
  if (!cols.includes('quota_info')) db.exec('ALTER TABLE upstream_accounts ADD COLUMN quota_info TEXT');

  if (!table.sql.includes("'oauth'")) {
    logger.info('Migrating upstream_accounts: adding oauth credential type');
      db.exec(`
        CREATE TABLE upstream_accounts_new (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
          credential_type TEXT NOT NULL CHECK (credential_type IN ('cookie', 'api_key', 'session_token', 'oauth')),
          credentials TEXT NOT NULL,
          meta TEXT,
          quota_info TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'quota_exceeded', 'error', 'disabled')),
          last_used TIMESTAMP,
          last_error TEXT,
          daily_quota INTEGER NOT NULL DEFAULT 0,
          used_today INTEGER NOT NULL DEFAULT 0,
          quota_reset_at TIMESTAMP NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          weight INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          state_revision INTEGER NOT NULL DEFAULT 0,
          request_revision INTEGER NOT NULL DEFAULT 0,
          credential_revision INTEGER NOT NULL DEFAULT 0,
          last_refresh_revision INTEGER NOT NULL DEFAULT -1
        );
        INSERT INTO upstream_accounts_new (
          id, name, provider, credential_type, credentials, meta, quota_info, status, last_used, last_error,
          daily_quota, used_today, quota_reset_at, priority, weight, created_at, updated_at, state_revision, request_revision, credential_revision, last_refresh_revision
        )
        SELECT id, name, provider, credential_type, credentials, meta, quota_info, status, last_used, last_error,
               daily_quota, used_today, quota_reset_at, priority, weight, created_at, updated_at,
               ${cols.includes('state_revision') ? 'state_revision' : '0'}, ${cols.includes('request_revision') ? 'request_revision' : '0'}, ${cols.includes('credential_revision') ? 'credential_revision' : '0'}, ${cols.includes('last_refresh_revision') ? 'last_refresh_revision' : '-1'}
        FROM upstream_accounts;
        DROP TABLE upstream_accounts;
        ALTER TABLE upstream_accounts_new RENAME TO upstream_accounts;
        CREATE INDEX IF NOT EXISTS idx_upstream_accounts_status ON upstream_accounts(status, provider);
      `);

  }
}

/** Refuse rebuilds unless every discarded schema object is a known one. */
function assertSafeLegacyRebuild(db: Database.Database, tableSql: string, cols: string[]): void {
  // Tokenize rather than execute SQL from sqlite_master; preserve quoted literals exactly.
  const tokens = (sql: string): string[] => sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|[^\s]/g) ?? [];
  const normalize = (sql: string) => JSON.stringify(tokens(sql));
  const optional = new Set([
    'meta TEXT', 'quota_info TEXT', 'state_revision INTEGER NOT NULL DEFAULT 0',
    'request_revision INTEGER NOT NULL DEFAULT 0', 'credential_revision INTEGER NOT NULL DEFAULT 0',
    'last_refresh_revision INTEGER NOT NULL DEFAULT - 1',
  ].map(normalize));
  const clauses = (sql: string): string[] => {
    const ts = tokens(sql);
    if (ts.slice(0, 4).join(' ') !== 'CREATE TABLE upstream_accounts (') return [];
    let depth = 1, part: string[] = [], result: string[] = [];
    for (let i = 4; i < ts.length; i++) {
      const token = ts[i];
      if (token === '(') depth++;
      if (token === ')') depth--;
      if ((token === ',' && depth === 1) || (token === ')' && depth === 0)) {
        const item = JSON.stringify(part);
        if (!optional.has(item)) result.push(item);
        part = [];
        if (depth === 0) return i === ts.length - 1 ? result : [];
      } else part.push(token);
    }
    return [];
  };
  const canonical = SQL_SCHEMA.match(/CREATE TABLE IF NOT EXISTS upstream_accounts \([\s\S]*?\n\);/)?.[0]
    .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE').replace(/;$/, '').replace(", 'oauth'", '');
  const unsafe = (reason: string): never => { throw new Error(`Unsafe legacy upstream_accounts migration: ${reason}`); };
  if (!canonical || JSON.stringify(clauses(tableSql)) !== JSON.stringify(clauses(canonical)) || clauses(tableSql).length === 0) {
    unsafe('unrecognized table definition; manual migration required');
  }
  // table_info omits generated columns; compare against table_xinfo too.
  const allColumns = db.prepare('PRAGMA table_xinfo(upstream_accounts)').all() as { name: string; hidden: number }[];
  if (allColumns.some(c => c.hidden !== 0) || allColumns.length !== cols.length) unsafe('hidden or generated column');

  const known = new Set([
    'CREATE INDEX idx_upstream_accounts_status ON upstream_accounts(status, provider)',
    'CREATE TRIGGER upstream_state_revision AFTER UPDATE OF status, last_error ON upstream_accounts BEGIN UPDATE upstream_accounts SET state_revision = state_revision + 1 WHERE id = NEW.id; END',
    'CREATE TRIGGER upstream_state_revision AFTER UPDATE OF status, last_error ON upstream_accounts WHEN NEW.request_revision = OLD.request_revision BEGIN UPDATE upstream_accounts SET state_revision = state_revision + 1 WHERE id = NEW.id; END',
    'CREATE TRIGGER upstream_credential_revision AFTER UPDATE OF credentials, credential_type ON upstream_accounts BEGIN UPDATE upstream_accounts SET credential_revision = credential_revision + 1 WHERE id = NEW.id; END',
    "CREATE TRIGGER protect_account_usage_history BEFORE DELETE ON upstream_accounts WHEN EXISTS (SELECT 1 FROM usage_logs WHERE upstream_account_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'account has usage history'); END",
  ].map(normalize));
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all('upstream_accounts') as { type: string; name: string; sql: string }[];
  for (const object of objects) {
    if (!known.has(normalize(object.sql))) unsafe(`unrecognized ${object.type} ${JSON.stringify(object.name)}; manual migration required`);
  }
}

/** Return only an already-open singleton, without initializing or touching storage. */
export function requireInitializedDatabase(): Database.Database {
  const current = dbInstance;
  if (state !== 'initialized' || !current || !current.open || state !== 'initialized' || dbInstance !== current) throw new Error('Database is not initialized or is closed');
  return current;
}

/**
 * DB 인스턴스 가져오기
 */
export function getDb(): Database.Database {
  return initDatabase();
}

/**
 * DB 종료
 */
export function closeDatabase(): void {
  // Initialization is synchronous: record the request rather than closing a
  // handle mid-construction or recursively during initialization cleanup.
  if (state === 'initializing') { closeRequested = true; return; }
  if (state === 'closing') { closeRequested = true; return; }
  if (state === 'closed') return;
  if (!dbInstance) { state = 'closed'; return; }
  const current = dbInstance;
  state = 'closing';
  try {
    if (current.open) current.close();
    if (current.open !== false) throw new Error('Database close did not close connection');
  } catch (error) {
    state = 'quarantined';
    throw error;
  }
  dbInstance = null;
  state = 'closed';
  logger.info('Database closed');
}
