// Test-only extractor for a database owned by the disposable fixture worker.
// CAST(... AS BLOB) observes SQL-level bytes in the database encoding, not disk
// forensic bytes. SQLite may allocate while computing length, before our cap.
import { planLegacy429 } from '../../src/db/experimental-429-legacy-plan.mjs';

const table = `CREATE TABLE account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`;
const maxRows = 1024;
const maxBytes = 512 * 1024;
const tokens = sql => {
  if (typeof sql !== 'string' || sql.replace(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),>]|\s+/g, '') !== '') return null;
  return JSON.stringify(sql.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),>]/g));
};
const unsafe = () => { throw new Error('Unsafe 429 snapshot'); };

export function extractFixture429(db) {
  return db.transaction(() => {
    if (db.pragma('main.encoding', {simple:true}) !== 'UTF-8') unsafe();
    if (db.prepare(`SELECT 1 FROM temp.sqlite_schema WHERE name='account_429_cooldowns' COLLATE NOCASE
      OR (type='trigger' AND tbl_name='account_429_cooldowns' COLLATE NOCASE)`).get()) unsafe();
    const objects = db.prepare(`SELECT type,name,CASE WHEN length(CAST(sql AS BLOB)) <= 4096 THEN sql ELSE NULL END AS sql
      FROM main.sqlite_schema WHERE name='account_429_cooldowns' COLLATE NOCASE LIMIT 2`).all();
    const object = objects[0];
    if (objects.length !== 1 || !object || object.type !== 'table' || object.name !== 'account_429_cooldowns' || tokens(object.sql) !== tokens(table)) unsafe();
    const expectedColumns = [
      ['kind','TEXT',1,1,0], ['account_id','TEXT',1,2,0],
      ['observed_at','INTEGER',1,0,0], ['until_at','INTEGER',1,0,0],
      ['revision','INTEGER',1,0,0],
    ];
    let columnCount = 0;
    for (const column of db.prepare('PRAGMA main.table_xinfo(account_429_cooldowns)').iterate()) {
      const expected = expectedColumns[columnCount];
      if (!expected || column.cid !== columnCount || column.name !== expected[0] || column.type !== expected[1] ||
          column.notnull !== expected[2] || column.pk !== expected[3] || column.hidden !== expected[4] || column.dflt_value !== null) unsafe();
      columnCount++;
    }
    if (columnCount !== expectedColumns.length) unsafe();
    if (db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE tbl_name='account_429_cooldowns' COLLATE NOCASE
      AND (type='trigger' OR (type='index' AND sql IS NOT NULL))`).get()) unsafe();
    let indexCount = 0;
    for (const index of db.prepare('PRAGMA main.index_list(account_429_cooldowns)').iterate()) {
      if (++indexCount > 1 || index.name !== 'sqlite_autoindex_account_429_cooldowns_1' || index.unique !== 1 || index.origin !== 'pk' || index.partial !== 0) unsafe();
    }
    if (indexCount !== 1) unsafe();
    let keyCount = 0, indexColumns = 0;
    for (const key of db.prepare('PRAGMA main.index_xinfo(sqlite_autoindex_account_429_cooldowns_1)').iterate()) {
      if (++indexColumns > 3) unsafe();
      if (key.key === 1 && (key.name !== ['kind','account_id'][keyCount++] || key.desc !== 0 || key.coll !== 'BINARY')) unsafe();
    }
    if (keyCount !== 2) unsafe();
    const summary = db.prepare(`SELECT count(*) AS n, coalesce(sum(length(CAST(account_id AS BLOB))),0) AS bytes,
      coalesce(max(length(CAST(account_id AS BLOB))),0) AS largest,
      coalesce(max(length(CAST(kind AS BLOB))),0) AS largestKind FROM main.account_429_cooldowns`).safeIntegers().get();
    if (summary.n > BigInt(maxRows) || summary.bytes > BigInt(maxBytes) || summary.largest > 512n || summary.largestKind > 8n) unsafe();
    const rows = [];
    const seen = new Set();
    const decoder = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
    const readText = bytes => {
      const text = decoder.decode(bytes);
      if (!Buffer.from(text, 'utf8').equals(bytes)) unsafe();
      return text;
    };
    const query = db.prepare(`SELECT typeof(kind) AS kt, typeof(account_id) AS it,
      typeof(observed_at) AS ot, typeof(until_at) AS ut, typeof(revision) AS rt,
      CAST(kind AS BLOB) AS kb, CAST(account_id AS BLOB) AS ib,
      observed_at, until_at, revision FROM main.account_429_cooldowns ORDER BY kind,account_id`).safeIntegers();
    for (const row of query.iterate()) {
      if (row.kt !== 'text' || row.it !== 'text' || row.ot !== 'integer' || row.ut !== 'integer' || row.rt !== 'integer') unsafe();
      if (row.kb.length > 8 || row.ib.length < 1 || row.ib.length > 512) unsafe();
      const kind = readText(row.kb), id = readText(row.ib);
      if (!['siwc','upstream'].includes(kind) || id.includes('\0')) unsafe();
      for (const n of [row.observed_at,row.until_at,row.revision]) {
        if (typeof n !== 'bigint' || n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER)) unsafe();
      }
      if (row.revision <= 0n) unsafe();
      const key = JSON.stringify([kind,id]);
      if (seen.has(key)) unsafe();
      seen.add(key);
      rows.push({kind, account_id:id, observed_at:Number(row.observed_at), until_at:Number(row.until_at), revision:Number(row.revision)});
    }
    if (BigInt(rows.length) !== summary.n) unsafe();
    const proposals = planLegacy429(JSON.stringify(rows));
    if (proposals.length !== rows.length) unsafe();
    return {cooldowns:rows, proposals, extractionCounts:{counted:Number(summary.n), iterated:rows.length, planned:proposals.length}};
  })();
}
