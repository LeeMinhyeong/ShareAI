import type Database from 'better-sqlite3';
import { assertExperimentalAccountIds, validExperimentalAccountId } from './experimental-429-account-id.js';

/** Offline experiment only. Not wired to migrations, admission or provider traffic.
 * Caller supplies an already-open, isolated synthetic DB; never an application DB.
 * Exact SQL spelling is intentional and can reject equivalent schemas.
 * No in-band schema can prove provenance or protect against direct tampering.
 * All writers must preserve this schema and its counter; restoring old DB snapshots,
 * direct SQL tampering and uncertain commit acknowledgement are outside its guarantee.
 * A failure must not be retried without independently resolving the outcome.
 */
const markerSql = `CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0))`;
const restrictionSql = `CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id))`;
const max = 9223372036854775807n;
type Db = Database.Database;
type Kind = 'upstream' | 'siwc';

// This is not a migration and never creates schema or opens a database.
// A production upgrade would require a separately reviewed provisioning utility.
function validateState(db: Db): bigint {
  const expected = new Map([
    ['experimental_atomic_429_marker', markerSql],
    ['experimental_atomic_429_restrictions', restrictionSql],
    ['ordinary_account_attempts', 'CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL)'],
    ['siwc_account_attempts', 'CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL)'],
  ]);
  const objects = db.prepare("SELECT type,name,sql FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all() as {type:string;name:string;sql:string}[];
  if (objects.length !== expected.size || objects.some(o => o.type !== 'table' || expected.get(o.name) !== o.sql)) throw new Error('Invalid experimental restriction schema');
  if (db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) throw new Error('Invalid experimental restriction schema');
  for (const [table, columns] of [
    ['experimental_atomic_429_marker', []],
    ['experimental_atomic_429_restrictions', ['kind','account_id']],
    ['ordinary_account_attempts', ['account_id']],
    ['siwc_account_attempts', ['account_id']],
  ] as [string,string[]][]) {
    const indexes = db.prepare(`PRAGMA main.index_list("${table}")`).all() as {name:string;unique:number;origin:string;partial:number}[];
    if (indexes.length !== (columns.length ? 1 : 0)) throw new Error('Invalid experimental restriction schema');
    if (columns.length) {
      const index = indexes[0];
      if (index.name !== `sqlite_autoindex_${table}_1` || index.unique !== 1 || index.origin !== 'pk' || index.partial !== 0) throw new Error('Invalid experimental restriction schema');
      const keys = (db.prepare(`PRAGMA main.index_xinfo("${index.name}")`).all() as {name:string;key:number;desc:number;coll:string}[]).filter(k => k.key === 1);
      if (keys.length !== columns.length || keys.some((k,i) => k.name !== columns[i] || k.desc !== 0 || k.coll !== 'BINARY')) throw new Error('Invalid experimental restriction schema');
    }
  }
  const rows = db.prepare('SELECT id,version,generation FROM main.experimental_atomic_429_marker').safeIntegers().all() as {id:bigint;version:bigint;generation:bigint}[];
  if (rows.length !== 1 || rows[0].id !== 1n || rows[0].version !== 1n || typeof rows[0].generation !== 'bigint' || rows[0].generation < 0n || rows[0].generation >= max) throw new Error('Invalid or exhausted generation counter');
  const counter = rows[0].generation;
  const bad = db.prepare(`SELECT 1 FROM main.experimental_atomic_429_restrictions WHERE typeof(kind)<>'text' OR kind NOT IN ('upstream','siwc') OR typeof(account_id)<>'text' OR length(account_id)=0 OR typeof(generation)<>'integer' OR generation<=0 OR generation>? OR (duration_ns IS NOT NULL AND (typeof(duration_ns)<>'integer' OR duration_ns<0)) LIMIT 1`).get(counter);
  if (bad) throw new Error('Invalid restriction state');
  assertExperimentalAccountIds(db);
  return counter;
}

type Settlement = {kind:Kind; accountId:string; attemptId:string; durationNs:bigint|null};

/** Synthetic only. Caller must already hold BEGIN IMMEDIATE and propagate any
 * error out of its transaction callback so all writes roll back. inTransaction
 * cannot prove the lock type. Return is provisional until the caller commits;
 * uncertain commit acknowledgement must be handled as an unknown outcome. */
function armAndSettleInWriter(db: Db, input: Settlement): bigint {
  if (!db.inTransaction) throw new Error('Requires an active immediate writer transaction');
  const {kind, accountId, attemptId, durationNs} = input;
  if ((kind !== 'upstream' && kind !== 'siwc') || !validExperimentalAccountId(accountId) || typeof attemptId !== 'string' || !attemptId || (durationNs !== null && (typeof durationNs !== 'bigint' || durationNs < 0n || durationNs > max))) throw new Error('Invalid restriction input');
  const attempts = kind === 'upstream' ? 'main.ordinary_account_attempts' : 'main.siwc_account_attempts';
  const current = validateState(db);
  if (!db.prepare(`SELECT 1 FROM ${attempts} WHERE account_id=? AND attempt_id=?`).get(accountId, attemptId)) throw new Error('Attempt ownership lost');
  const old = db.prepare('SELECT duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind,accountId) as {duration_ns:bigint|null} | undefined;
  const duration = old ? (old.duration_ns === null || durationNs === null ? null : old.duration_ns > durationNs ? old.duration_ns : durationNs) : durationNs;
  const generation = current + 1n;
  if (db.prepare('UPDATE main.experimental_atomic_429_marker SET generation=? WHERE id=1 AND generation=?').run(generation,current).changes !== 1) throw new Error('Generation update failed');
  if (db.prepare(`INSERT INTO main.experimental_atomic_429_restrictions (kind,account_id,generation,duration_ns) VALUES (?,?,?,?) ON CONFLICT(kind,account_id) DO UPDATE SET generation=excluded.generation,duration_ns=excluded.duration_ns`).run(kind,accountId,generation,duration).changes !== 1) throw new Error('Restriction update failed');
  if (db.prepare(`DELETE FROM ${attempts} WHERE account_id=? AND attempt_id=?`).run(accountId,attemptId).changes !== 1) throw new Error('Attempt ownership lost');
  return generation;
}

/** Standalone synchronous synthetic experiment; never use with an outer transaction. */
export function armAndSettle(db: Db, input: Settlement): bigint {
  if (db.inTransaction) throw new Error('Cannot settle inside an active transaction');
  return db.transaction(() => armAndSettleInWriter(db, input)).immediate();
}
