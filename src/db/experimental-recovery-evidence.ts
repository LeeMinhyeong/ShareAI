import Database from 'better-sqlite3';
import { validateLedgerInTransaction } from './durable-ledger-foundation.js';

/** Isolated experimental evidence only. This is NOT a maintenance fence,
 * authorization, proof of drained providers, or permission to clear anything.
 * Only trusted callers and an independently protected SQLite file are in scope. */
const table = 'phase4_experimental_recovery_evidence';
const ddl = `CREATE TABLE ${table} (
  id INTEGER PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision=1),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason='INVESTIGATE_OPEN')
);
CREATE TRIGGER phase4_experimental_recovery_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER phase4_experimental_recovery_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER phase4_experimental_recovery_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'append only'); END;`;
function rows(db: Database.Database, catalog: 'sqlite_master' | 'sqlite_temp_master'): unknown[] {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM ${catalog} WHERE substr(lower(name),1,29)='phase4_experimental_recovery_' OR lower(tbl_name)=? ORDER BY type,name`).all(table);
}
const reference = (() => { const db = new Database(':memory:'); try { db.exec(ddl); return JSON.stringify(rows(db,'sqlite_master')); } finally { db.close(); } })();
function validate(db: Database.Database): void {
  if (JSON.stringify(rows(db,'sqlite_master')) !== reference || rows(db,'sqlite_temp_master').length) throw new Error('Unsupported evidence schema');
  const integrity = db.pragma(`integrity_check('${table}')`) as {integrity_check:string}[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Invalid evidence data');
}
function configure(db: Database.Database): void {
  if (db.inTransaction) throw new Error('Evidence API requires no active transaction');
  db.pragma('busy_timeout = 0');
  db.pragma('synchronous = FULL');
}
/** Explicit scratch-only migration; not called from startup. */
export function migrateEvidence(db: Database.Database): void {
  configure(db);
  db.transaction(() => {
    if (rows(db,'sqlite_master').length === 0 && rows(db,'sqlite_temp_master').length === 0) db.exec(ddl);
    validate(db);
  }).immediate();
}
export function prepareEvidence(db: Database.Database, input: {attemptId:string; revision:number; actor:string; reason:'INVESTIGATE_OPEN'}): boolean {
  if (!input || typeof input.attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId) || input.revision !== 1 ||
      typeof input.actor !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.actor) || input.reason !== 'INVESTIGATE_OPEN') throw new Error('Invalid evidence');
  configure(db);
  return db.transaction(() => {
    validate(db);
    validateLedgerInTransaction(db);
    const open = db.prepare("SELECT 1 FROM main.phase4_experimental_ledger_attempts WHERE id=? AND state='OPEN' AND revision=?").get(input.attemptId,input.revision);
    if (!open) return false;
    db.prepare(`INSERT INTO main.${table} (attempt_id,revision,actor,reason) VALUES (?,?,?,?)`).run(input.attemptId,input.revision,input.actor,input.reason);
    return true;
  }).immediate();
}
