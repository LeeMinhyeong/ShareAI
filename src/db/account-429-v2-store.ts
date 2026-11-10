import type Database from 'better-sqlite3';

// Startup validates this staged storage; settlement and selection are not wired.
// It is not an upgrade or an old-binary fence and must not be deployed by itself.
const marker = `CREATE TABLE account_429_v2_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=2))`;
const counter = `CREATE TABLE account_429_v2_counter (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0))`;
const restrictions = `CREATE TABLE account_429_v2_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(typeof(account_id)='text'), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ms INTEGER CHECK(duration_ms IS NULL OR (typeof(duration_ms)='integer' AND duration_ms>=0)), PRIMARY KEY(kind,account_id))`;
const schemas = [marker, counter, restrictions];
const names = ['account_429_v2_schema_marker', 'account_429_v2_counter', 'account_429_v2_restrictions'];
const maxGeneration = 9223372036854775807n;
const maxDuration = BigInt(Number.MAX_SAFE_INTEGER);
const invalidId = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function transactionRequired(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('429 v2 requires a caller-owned transaction');
}

function conflictCheck(db: Database.Database, schema: 'main' | 'temp', allowTables: boolean): void {
  const entries = db.prepare(`SELECT type, substr(name,1,4096) AS name,
    substr(tbl_name,1,4096) AS tbl_name, substr(sql,1,4096) AS sql
    FROM ${schema}.sqlite_schema WHERE lower(name) IN (?, ?, ?) OR lower(tbl_name) IN (?, ?, ?)`)
    .iterate(...names, ...names) as Iterable<{type: string; name: string; tbl_name: string; sql: string | null}>;
  const found = new Set<string>();
  for (const e of entries) {
    const nameIndex = names.indexOf(e.name.toLowerCase());
    const targetIndex = names.indexOf(e.tbl_name.toLowerCase());
    if (nameIndex >= 0 && !(allowTables && e.type === 'table' && e.name === names[nameIndex] && e.sql === schemas[nameIndex])) throw new Error('Unsafe 429 v2 schema');
    if (targetIndex >= 0 && e.type !== 'table' && !(allowTables && e.type === 'index' && e.sql === null && e.name === 'sqlite_autoindex_account_429_v2_restrictions_1' && targetIndex === 2)) throw new Error('Unsafe 429 v2 schema');
    if (e.type === 'table' && nameIndex >= 0) found.add(e.name);
  }
  if (allowTables && names.some(name => !found.has(name))) throw new Error('Unsafe 429 v2 schema');
  // Incoming foreign keys can cascade or prevent writes even with canonical tables.
  const incoming = db.prepare(`SELECT 1 FROM ${schema}.sqlite_schema AS s,
    pragma_foreign_key_list(s.name, '${schema}') AS f
    WHERE s.type='table' AND lower(f."table") IN (?, ?, ?) LIMIT 1`).get(...names);
  if (incoming) throw new Error('Unsafe 429 v2 schema');
}

/** Validate canonical schema and all extant rows. Historical counter rollback
 * after relevant rows are deleted cannot be detected from this database alone.
 * Mutation callers must provide a trusted BEGIN IMMEDIATE writer transaction;
 * inTransaction cannot establish its lock mode or ownership. */
export function assert429V2Schema(db: Database.Database): bigint {
  conflictCheck(db, 'main', true);
  conflictCheck(db, 'temp', false);
  const versions = db.prepare('SELECT id, version FROM main.account_429_v2_schema_marker LIMIT 2').safeIntegers().all() as {id: bigint; version: bigint}[];
  if (versions.length !== 1 || versions[0].id !== 1n || versions[0].version !== 2n) throw new Error('Unsafe 429 v2 schema marker');
  const rows = db.prepare('SELECT id, generation FROM main.account_429_v2_counter LIMIT 2').safeIntegers().all() as {id: bigint; generation: bigint}[];
  if (rows.length !== 1 || rows[0].id !== 1n || typeof rows[0].generation !== 'bigint' || rows[0].generation < 0n || rows[0].generation > maxGeneration) throw new Error('Unsafe 429 v2 counter');
  const counterValue = rows[0].generation;
  // Validate storage classes and counters before retrieving text.
  const malformed = db.prepare(`SELECT 1 FROM main.account_429_v2_restrictions
    WHERE typeof(kind) != 'text' OR kind NOT IN ('upstream','siwc')
       OR typeof(account_id) != 'text'
       OR typeof(generation) != 'integer' OR generation <= 0 OR generation > ?
       OR (duration_ms IS NOT NULL AND (typeof(duration_ms) != 'integer' OR duration_ms < 0 OR duration_ms > ?)) LIMIT 1`).get(counterValue, maxDuration);
  if (malformed) throw new Error('Unsafe 429 v2 restriction');
  if (db.prepare('SELECT 1 FROM main.account_429_v2_restrictions GROUP BY generation HAVING count(*) > 1 LIMIT 1').get()) throw new Error('Unsafe 429 v2 restriction');
  const roundTrip = db.prepare('SELECT CAST(account_id AS BLOB) = CAST(? AS BLOB) AS valid FROM main.account_429_v2_restrictions WHERE rowid=?');
  // Identify the exact row, not the decoded key: malformed UTF-8 may decode to
  // the same JavaScript string as a different, valid SQLite TEXT key.
  for (const entry of db.prepare('SELECT rowid, account_id FROM main.account_429_v2_restrictions').safeIntegers().iterate() as Iterable<{rowid: bigint; account_id: string}>) {
    if (invalidId.test(entry.account_id) || !(roundTrip.get(entry.account_id, entry.rowid) as {valid: number} | undefined)?.valid) throw new Error('Unsafe 429 v2 restriction');
  }
  return rows[0].generation;
}

/** Fresh databases only. Caller must attest the existing database is pristine.
 * Caller must own a trusted BEGIN IMMEDIATE writer and roll it back on any error.
 * The transaction check cannot verify the lock mode. This is not a migration.
 * A future migration must explicitly reject or quarantine NULL IDs (ordinary
 * SQLite TEXT PRIMARY KEY allows them) and byte-ill-formed legacy TEXT IDs;
 * it must never silently omit them or replace bytes during decoding.
 */
export function provision429V2(db: Database.Database): void {
  transactionRequired(db);
  conflictCheck(db, 'main', false);
  conflictCheck(db, 'temp', false);
  for (const sql of schemas) db.exec(sql.replace('CREATE TABLE ', 'CREATE TABLE main.'));
  db.prepare('INSERT INTO main.account_429_v2_schema_marker VALUES (1, 2)').run();
  db.prepare('INSERT INTO main.account_429_v2_counter VALUES (1, 0)').run();
  assert429V2Schema(db);
}

/** Arm inside a trusted caller-owned BEGIN IMMEDIATE writer; the caller owns OPEN
 * and rollback. inTransaction checks neither lock mode nor writer ownership. */
export function arm429V2(db: Database.Database, kind: 'upstream' | 'siwc', accountId: string, durationMs: number | bigint | null): void {
  transactionRequired(db);
  if (kind !== 'upstream' && kind !== 'siwc') throw new Error('Invalid 429 v2 kind');
  // Reject unpaired UTF-16 surrogates: SQLite's UTF-8 conversion would change the key.
  if (typeof accountId !== 'string' || invalidId.test(accountId)) throw new Error('Invalid 429 v2 account id');
  if (durationMs !== null && !(typeof durationMs === 'bigint' ? durationMs >= 0n && durationMs <= maxDuration : typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs >= 0)) throw new Error('Invalid 429 v2 duration');
  const duration = durationMs === null ? null : BigInt(durationMs);
  const oldCounter = assert429V2Schema(db);
  if (oldCounter === maxGeneration) throw new Error('429 v2 generation exhausted');
  const old = db.prepare('SELECT generation, duration_ms FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind, accountId) as {generation: bigint; duration_ms: bigint | null} | undefined;
  if (old && (typeof old.generation !== 'bigint' || old.generation <= 0n || old.generation > oldCounter || (old.duration_ms !== null && (typeof old.duration_ms !== 'bigint' || old.duration_ms < 0n || old.duration_ms > maxDuration)))) throw new Error('Unsafe 429 v2 restriction');
  const next = oldCounter + 1n;
  const updated = db.prepare('UPDATE main.account_429_v2_counter SET generation=? WHERE id=1 AND generation=?').run(next, oldCounter);
  if (updated.changes !== 1) throw new Error('429 v2 counter conflict');
  const effective = !old ? duration : old.duration_ms === null || duration === null ? null : old.duration_ms > duration ? old.duration_ms : duration;
  db.prepare(`INSERT INTO main.account_429_v2_restrictions (kind, account_id, generation, duration_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, account_id) DO UPDATE SET generation=excluded.generation, duration_ms=excluded.duration_ms`).run(kind, accountId, next, effective);
}
