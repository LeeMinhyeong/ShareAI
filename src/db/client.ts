/**
 * SQLite 데이터베이스 클라이언트
 */
import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { SQL_SCHEMA } from './schema.js';
import path from 'path';
import fs from 'fs';

let dbInstance: Database.Database | null = null;
let closed = false;

/**
 * SQLite DB 초기화
 */
export function initDatabase(): Database.Database {
  if (closed) throw new Error('Database is closed');
  if (dbInstance) {
    return dbInstance;
  }

  // DATABASE_URL에서 파일 경로 추출 (sqlite:./data/router.db)
  const dbPath = env.DATABASE_URL.replace('sqlite:', '');
  
  // 디렉토리 생성
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ dbPath }, 'Initializing SQLite database');

  dbInstance = new Database(dbPath);
  
  // WAL 모드 활성화 (동시성 향상)
  dbInstance.pragma('journal_mode = WAL');
  // The refresh intent must survive a power loss before the provider is called.
  dbInstance.pragma('synchronous = FULL');
  
  // Foreign keys must be disabled before the transaction for the legacy rebuild.
  // Hold one write lock across schema creation, discovery, and every migration.
  dbInstance.pragma('foreign_keys = OFF');
  try {
    dbInstance.transaction(() => {
      dbInstance!.exec(SQL_SCHEMA);
      migrate(dbInstance!);
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
      // Never expire intents: an interrupted exchange has an unknowable outcome.
      dbInstance!.exec(`CREATE TABLE IF NOT EXISTS oauth_refresh_intents (
        token_fingerprint TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
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
    }).immediate();
  } catch (error) {
    dbInstance.close();
    dbInstance = null;
    throw error;
  } finally {
    dbInstance?.pragma('foreign_keys = ON');
  }
  
  logger.info('Database initialized successfully');
  
  return dbInstance;
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

/**
 * DB 인스턴스 가져오기
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * DB 종료
 */
export function closeDatabase(): void {
  closed = true;
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('Database closed');
  }
}
