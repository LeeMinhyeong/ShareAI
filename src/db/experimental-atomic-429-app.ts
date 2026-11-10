import type Database from 'better-sqlite3';
import { requireInitializedDatabase, validateOrdinaryProvisioning, validateSiwcProvisioning } from './client.js';
import { withAsyncWriter } from './async-writer.js';
import { assertExperimentalAccountIds, validExperimentalAccountId } from './experimental-429-account-id.js';

/** Isolated experiment only; no provisioning or production traffic integration. */
type Settlement = {kind:'upstream'|'siwc'; accountId:string; attemptId:string; durationNs:bigint|null};
type Db = Database.Database;
const max = 9223372036854775807n;
const definitions = new Map([
  ['experimental_atomic_429_marker', `CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0))`],
  ['experimental_atomic_429_restrictions', `CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id))`],
]);
const protectedNames = new Set([...definitions.keys(), 'ordinary_account_attempts', 'siwc_account_attempts', 'ordinary_attempts_schema_marker', 'siwc_attempts_schema_marker']);
const invalid = (): never => { throw new Error('Invalid experimental restriction schema'); };
function validateTemp(db: Db): void {
  // Reject all TEMP objects: even an unrelated trigger can have arbitrary effects.
  if (db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) invalid();
}
function validate(db: Db): bigint {
  validateTemp(db);
  if (!validateOrdinaryProvisioning(db) || !validateSiwcProvisioning(db)) invalid();
  for (const [name, sql] of definitions) {
    const object = db.prepare('SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE').get(name) as {type:string;name:string;sql:string}|undefined;
    if (!object || object.type !== 'table' || object.name !== name || object.sql !== sql) invalid();
    if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE tbl_name=? COLLATE NOCASE AND (type='trigger' OR (type='index' AND sql IS NOT NULL))").get(name)) invalid();
    const indexes = db.prepare(`PRAGMA main.index_list("${name}")`).all() as {name:string;unique:number;origin:string;partial:number}[];
    const columns = name.endsWith('_restrictions') ? ['kind','account_id'] : [];
    if (indexes.length !== (columns.length ? 1 : 0)) invalid();
    if (columns.length) {
      const index = indexes[0];
      if (index.name !== `sqlite_autoindex_${name}_1` || index.unique !== 1 || index.origin !== 'pk' || index.partial !== 0) invalid();
      const keys = (db.prepare(`PRAGMA main.index_xinfo("${index.name}")`).all() as {name:string;key:number;desc:number;coll:string}[]).filter(k => k.key === 1);
      if (keys.length !== columns.length || keys.some((k,i) => k.name !== columns[i] || k.desc !== 0 || k.coll !== 'BINARY')) invalid();
    }
  }
  // Reject views and incoming foreign keys, which can otherwise introduce hidden effects.
  if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='view' LIMIT 1").get()) invalid();
  for (const row of db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all() as {name:string}[]) {
    const quoted = `"${row.name.replace(/"/g,'""')}"`;
    if ((db.prepare(`PRAGMA main.foreign_key_list(${quoted})`).all() as {table:string}[]).some(f => protectedNames.has(f.table.toLowerCase()))) invalid();
  }
  const rows = db.prepare('SELECT id,version,generation FROM main.experimental_atomic_429_marker').safeIntegers().all() as {id:bigint;version:bigint;generation:bigint}[];
  if (rows.length !== 1 || rows[0].id !== 1n || rows[0].version !== 1n || typeof rows[0].generation !== 'bigint' || rows[0].generation < 0n || rows[0].generation >= max) throw new Error('Invalid or exhausted generation counter');
  const current = rows[0].generation;
  if (db.prepare(`SELECT 1 FROM main.experimental_atomic_429_restrictions WHERE typeof(kind)<>'text' OR kind NOT IN ('upstream','siwc') OR typeof(account_id)<>'text' OR length(account_id)=0 OR typeof(generation)<>'integer' OR generation<=0 OR generation>? OR (duration_ns IS NOT NULL AND (typeof(duration_ns)<>'integer' OR duration_ns<0)) LIMIT 1`).get(current)) throw new Error('Invalid restriction state');
  assertExperimentalAccountIds(db);
  return current;
}
/** Read-only validation shared by the isolated expiry prototype. */
export function assertExperimental429Schema(db: Db): bigint { return validate(db); }

function armInActualWriter(db: Db, input: Settlement): bigint {
  const {kind, accountId, attemptId, durationNs} = input;
  if ((kind !== 'upstream' && kind !== 'siwc') || !validExperimentalAccountId(accountId) || typeof attemptId !== 'string' || !attemptId || (durationNs !== null && (typeof durationNs !== 'bigint' || durationNs < 0n || durationNs > max))) throw new Error('Invalid restriction input');
  const current = validate(db);
  const table = kind === 'upstream' ? 'main.ordinary_account_attempts' : 'main.siwc_account_attempts';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE account_id=? AND attempt_id=?`).get(accountId,attemptId)) throw new Error('Attempt ownership lost');
  const old = db.prepare('SELECT duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind,accountId) as {duration_ns:bigint|null}|undefined;
  const duration = old ? (old.duration_ns === null || durationNs === null ? null : old.duration_ns > durationNs ? old.duration_ns : durationNs) : durationNs;
  const generation = current + 1n;
  if (db.prepare('UPDATE main.experimental_atomic_429_marker SET generation=? WHERE id=1 AND generation=?').run(generation,current).changes !== 1) throw new Error('Generation update failed');
  if (db.prepare('INSERT INTO main.experimental_atomic_429_restrictions (kind,account_id,generation,duration_ns) VALUES (?,?,?,?) ON CONFLICT(kind,account_id) DO UPDATE SET generation=excluded.generation,duration_ns=excluded.duration_ns').run(kind,accountId,generation,duration).changes !== 1) throw new Error('Restriction update failed');
  if (db.prepare(`DELETE FROM ${table} WHERE account_id=? AND attempt_id=?`).run(accountId,attemptId).changes !== 1) throw new Error('Attempt ownership lost');
  return generation;
}
/** Resolves only after commit. An uncertain commit acknowledgement is an unknown outcome. */
export async function settleAppAttempt(input: Settlement): Promise<bigint> {
  const shared = requireInitializedDatabase();
  const snapshot = {kind:input.kind, accountId:input.accountId, attemptId:input.attemptId, durationNs:input.durationNs};
  validateTemp(shared);
  return await withAsyncWriter(db => {
    validateTemp(shared);
    return armInActualWriter(db,snapshot);
  });
}
