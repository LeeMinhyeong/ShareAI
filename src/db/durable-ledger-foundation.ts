import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** Isolated experimental primitive, NOT a production dispatch gate.
 * One global envelope only: no assumed provider/account independence, TTL,
 * recovery, quota reservation, network dispatch, or secret-bearing fields.
 * Callers must not dispatch based on this primitive. */
const prefix = 'phase4_experimental_ledger_';
type Outcome = 'SUCCESS' | 'UNKNOWN_429';
type FinishResult = 'finished' | 'duplicate' | 'conflict';

function configure(db: Database.Database): void {
  // better-sqlite3 nests transaction wrappers as savepoints: releasing one is
  // not a durable commit, so these public APIs must own the outer transaction.
  if (db.inTransaction) throw new Error('Ledger API requires no active transaction');
  db.pragma('busy_timeout = 0');
  db.pragma('synchronous = FULL');
}
function checkId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid opaque attempt ID');
}
const ddlV1 = `
      CREATE TABLE ${prefix}version (version INTEGER NOT NULL CHECK(version=1));
      CREATE TABLE ${prefix}attempts (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('OPEN','SUCCESS','UNKNOWN_429')),
        revision INTEGER NOT NULL CHECK(revision IN (1,2))
      );
      CREATE TABLE ${prefix}restrictions (
        source_id TEXT PRIMARY KEY NOT NULL REFERENCES ${prefix}attempts(id),
        reason TEXT NOT NULL CHECK(reason='UNKNOWN_429')
      );`;
const claimDdl = `CREATE TABLE ${prefix}dispatch_claims (
        attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES ${prefix}attempts(id),
        owner TEXT NOT NULL CHECK(length(owner)=36)
      );`;
const ddlV2 = ddlV1.replace('CHECK(version=1)', 'CHECK(version=2)') + claimDdl;
const namesV1 = [`${prefix}version`, `${prefix}attempts`, `${prefix}restrictions`];
const names = [...namesV1, `${prefix}dispatch_claims`];
// Build the reference with the same SQLite engine; compare stored SQL exactly,
// rather than lossy normalization that could erase meaningful SQL syntax.
function makeReference(ddl: string, tables: string[]): unknown[] {
  const db = new Database(':memory:');
  try { db.exec(ddl); return schemaRows(db, 'sqlite_master', tables); } finally { db.close(); }
}
const referenceV1 = makeReference(ddlV1, namesV1);
const referenceV2 = makeReference(ddlV2, names);
function schemaRows(db: Database.Database, catalog: 'sqlite_master' | 'sqlite_temp_master', tables: string[]): unknown[] {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM ${catalog}
    WHERE substr(lower(name),1,length(?)) = ? OR tbl_name COLLATE NOCASE IN (${tables.map(() => '?').join(',')}) ORDER BY type,name`).all(prefix, prefix, ...tables);
}
/** Internal experimental validation; caller owns the writer transaction. */
export function validateLedgerInTransaction(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('Ledger validation requires an active writer transaction');
  checkVersion(db);
}
function checkVersion(db: Database.Database, version: 1 | 2 = 2): void {
  const tables = version === 1 ? namesV1 : names;
  if (JSON.stringify(schemaRows(db, 'sqlite_master', tables)) !== JSON.stringify(version === 1 ? referenceV1 : referenceV2) ||
      schemaRows(db, 'sqlite_temp_master', tables).length !== 0) throw new Error('Unsupported ledger schema');
  const rows = db.prepare(`SELECT version FROM main.${prefix}version`).all() as {version: number}[];
  if (rows.length !== 1 || rows[0].version !== version) throw new Error('Unsupported ledger schema');
  // Table-scoped integrity checks verify the physical indexes and CHECK/NOT NULL
  // constraints without examining unrelated application tables.
  for (const name of tables) {
    const result = db.pragma(`integrity_check('${name}')`) as {integrity_check: string}[];
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('Invalid ledger data');
  }
  const attempts = db.prepare(`SELECT id,state,revision FROM main.${prefix}attempts`).all() as {id: unknown; state: string; revision: number}[];
  const restrictions = db.prepare(`SELECT source_id,reason FROM main.${prefix}restrictions`).all() as {source_id: string; reason: string}[];
  let open = 0; let unknown = 0;
  for (const row of attempts) {
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
        (row.state === 'OPEN' ? row.revision !== 1 :
          (row.state !== 'SUCCESS' && row.state !== 'UNKNOWN_429') || row.revision !== 2)) throw new Error('Invalid ledger data');
    if (row.state === 'OPEN') open++;
    if (row.state === 'UNKNOWN_429') unknown++;
  }
  if (open > 1 || unknown > 1 || (open && unknown) || restrictions.length !== unknown ||
      restrictions.some(r => r.reason !== 'UNKNOWN_429' || !attempts.some(a => a.id === r.source_id && a.state === 'UNKNOWN_429'))) {
    throw new Error('Invalid ledger data');
  }
  if (version === 2) {
    const claims = db.prepare(`SELECT attempt_id,owner FROM main.${prefix}dispatch_claims`).all() as {attempt_id: string; owner: string}[];
    if (claims.some(c => !attempts.some(a => a.id === c.attempt_id) ||
        typeof c.owner !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.owner))) throw new Error('Invalid ledger data');
  }
}
/** Explicit additive migration. Never called by application startup. */
export function migrateLedger(db: Database.Database): void {
  configure(db);
  db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${prefix}version`);
    if (exists) {
      const rows = db.prepare(`SELECT version FROM ${prefix}version`).all() as {version: number}[];
      if (rows.length !== 1) throw new Error('Unsupported ledger schema');
      if (rows[0].version === 2) { checkVersion(db); return; }
      checkVersion(db, 1);
      // A v1 OPEN may already have initiated remote work. Its history cannot
      // prove otherwise, so migration must not turn it into a fresh claim.
      if (db.prepare(`SELECT 1 FROM ${prefix}attempts WHERE state='OPEN'`).get()) throw new Error('Cannot migrate v1 ledger with OPEN attempt');
      db.exec(`DROP TABLE ${prefix}version; CREATE TABLE ${prefix}version (version INTEGER NOT NULL CHECK(version=2)); ${claimDdl}`);
      db.prepare(`INSERT INTO ${prefix}version VALUES (2)`).run();
      checkVersion(db);
      return;
    }
    db.exec(ddlV2);
    db.prepare(`INSERT INTO ${prefix}version VALUES (2)`).run();
    checkVersion(db);
  }).immediate();
}
/** Experimental writer callback, not a durability or dispatch authorization.
 * The caller must propagate errors, own the outer commit, and never initiate
 * external work until that commit is confirmed. Never retry an uncertain commit. */
export function createOpenAttemptCallback(id: string): (db: Database.Database) => void {
  checkId(id);
  return db => {
    if (!db.inTransaction) throw new Error('Ledger callback requires an active writer transaction');
    // Force a write lock even if the caller began a deferred transaction.
    db.prepare(`UPDATE ${prefix}version SET version=version`).run();
    checkVersion(db);
    if (db.prepare(`SELECT 1 FROM ${prefix}attempts WHERE state='OPEN' LIMIT 1`).get() ||
        db.prepare(`SELECT 1 FROM ${prefix}restrictions LIMIT 1`).get()) throw new Error('Ledger globally fenced');
    db.prepare(`INSERT INTO ${prefix}attempts (id,state,revision) VALUES (?,'OPEN',1)`).run(id);
  };
}
/** Experimental dispatch-fence callback, not dispatch authorization. The
 * caller must first confirm the OPEN's outer commit, then invoke this under a
 * new writer transaction alongside all credential, ACL and logout checks and
 * initiate external work before releasing that fence. Never retry an uncertain
 * commit or assume this callback itself proves the OPEN was committed. This
 * check is not one-shot: the caller must prevent replay of an attempt ID. */
function createOpenAttemptDispatchFence(id: string): (db: Database.Database) => void {
  checkId(id);
  return db => {
    if (!db.inTransaction) throw new Error('Ledger callback requires an active writer transaction');
    db.prepare(`UPDATE ${prefix}version SET version=version`).run();
    checkVersion(db);
    const row = db.prepare(`SELECT state,revision FROM ${prefix}attempts WHERE id=?`).get(id) as {state: string; revision: number} | undefined;
    if (!row || row.state !== 'OPEN' || row.revision !== 1 ||
        db.prepare(`SELECT 1 FROM ${prefix}restrictions LIMIT 1`).get()) throw new Error('Ledger globally fenced');
  };
}
/** Experimental only. OPEN must already have a confirmed separate commit.
 * Callbacks are trusted internal code, synchronous through initiation, and must
 * not manipulate the ledger or re-enter this coordinator. An uncertain claim
 * commit or any failure after it permanently consumes the claim. The optional
 * trusted synchronous classifier runs only after start's promise fulfills.
 * That promise must represent completion of all remote work (including any
 * streaming body), not just receipt of response headers; the classifier must
 * report SUCCESS only for confirmed terminal success. It and the callbacks
 * are application trust boundaries, not protection against dishonest callers
 * or direct database mutation. An absent or inconclusive classification leaves
 * OPEN permanently fenced. NOT PRODUCTION. */
export async function dispatchOpenAttemptOnce<T>(source: string | Database.Database, id: string, gate: (db: Database.Database) => unknown, start: () => Promise<T>, classify?: (result: T) => Outcome | undefined): Promise<T> {
  checkId(id);
  if (typeof source !== 'string' && source.inTransaction) throw new Error('Ledger API requires no active transaction');
  const file = typeof source === 'string' ? source : source.name;
  if (typeof file !== 'string' || !file || file === ':memory:') throw new Error('A persistent ledger file is required');
  const db = new Database(file, {fileMustExist: true, timeout: 0});
  let started: Promise<T> | undefined;
  const owner = randomUUID();
  try {
    configure(db);
    db.transaction(() => {
      createOpenAttemptDispatchFence(id)(db);
      db.prepare(`INSERT INTO ${prefix}dispatch_claims (attempt_id,owner) VALUES (?,?)`).run(id, owner);
    }).immediate();
    db.transaction(() => {
      createOpenAttemptDispatchFence(id)(db);
      if (!db.prepare(`SELECT 1 FROM ${prefix}dispatch_claims WHERE attempt_id=? AND owner=?`).get(id, owner)) throw new Error('Ledger claim lost');
      const result = gate(db);
      if (result && typeof (result as {then?: unknown}).then === 'function') {
        void Promise.resolve(result).catch(() => {});
        throw new Error('Ledger gate must be synchronous');
      }
      if (result === false) throw new Error('Ledger gate denied');
      started = Promise.resolve(start());
      void started.catch(() => {});
    }).immediate();
  } finally { db.close(); }
  const result = await started!;
  const outcome = classify?.(result);
  if (outcome === 'SUCCESS' || outcome === 'UNKNOWN_429') {
    const finalDb = new Database(file, {fileMustExist: true, timeout: 0});
    try {
      configure(finalDb);
      finalDb.transaction(() => {
        checkVersion(finalDb);
        if (!finalDb.prepare(`SELECT 1 FROM ${prefix}dispatch_claims WHERE attempt_id=? AND owner=?`).get(id, owner)) throw new Error('Ledger claim lost');
        if (finishInTransaction(finalDb, id, 1, outcome) !== 'finished') throw new Error('Ledger completion conflict');
      }).immediate();
    } finally { finalDb.close(); }
  }
  return result;
}
/** Admission and OPEN are one transaction. False means globally fenced. */
export function openAttempt(db: Database.Database, id: string): boolean {
  checkId(id); configure(db);
  return db.transaction(() => {
    checkVersion(db);
    if (db.prepare(`SELECT 1 FROM ${prefix}attempts WHERE state='OPEN' LIMIT 1`).get() ||
        db.prepare(`SELECT 1 FROM ${prefix}restrictions LIMIT 1`).get()) return false;
    db.prepare(`INSERT INTO ${prefix}attempts (id,state,revision) VALUES (?,'OPEN',1)`).run(id);
    return true;
  }).immediate();
}
/** Caller presents the original OPEN revision. Success never clears restrictions. */
export function finishAttempt(db: Database.Database, id: string, revision: number, outcome: Outcome): FinishResult {
  checkId(id);
  configure(db);
  return db.transaction(() => {
    checkVersion(db);
    if (db.prepare(`SELECT 1 FROM ${prefix}dispatch_claims WHERE attempt_id=?`).get(id)) return 'conflict';
    return finishInTransaction(db, id, revision, outcome);
  }).immediate();
}
function finishInTransaction(db: Database.Database, id: string, revision: number, outcome: Outcome): FinishResult {
  if (revision !== 1 || (outcome !== 'SUCCESS' && outcome !== 'UNKNOWN_429')) return 'conflict';
  const row = db.prepare(`SELECT state,revision FROM ${prefix}attempts WHERE id=?`).get(id) as {state: string; revision: number} | undefined;
  if (!row) return 'conflict';
  if (row.state !== 'OPEN') return row.revision === 2 && row.state === outcome ? 'duplicate' : 'conflict';
  if (row.revision !== revision) return 'conflict';
  if (outcome === 'UNKNOWN_429') db.prepare(`INSERT INTO ${prefix}restrictions (source_id,reason) VALUES (?,'UNKNOWN_429')`).run(id);
  const updated = db.prepare(`UPDATE ${prefix}attempts SET state=?, revision=2 WHERE id=? AND state='OPEN' AND revision=?`).run(outcome,id,revision);
  if (updated.changes !== 1) throw new Error('Ledger CAS failed');
  return 'finished';
}
