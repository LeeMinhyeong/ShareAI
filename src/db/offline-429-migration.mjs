// INTERNAL STAGING ONLY: no startup, CLI, path handling or deployment wiring.
// Trusted caller must own a top-level BEGIN IMMEDIATE, roll back on any error,
// and commit itself. inTransaction proves neither lock mode nor savepoint depth.
// No durable-commit promise; SQLite cannot stop old binaries reconnecting.
const legacySql = `CREATE TABLE account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`;
const openSql = `CREATE TABLE NAME (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL)`;
const markerSql = `CREATE TABLE NAME (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1))`;
const v2 = [
  `CREATE TABLE account_429_v2_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=2))`,
  `CREATE TABLE account_429_v2_counter (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0))`,
  `CREATE TABLE account_429_v2_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(typeof(account_id)='text'), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ms INTEGER CHECK(duration_ms IS NULL OR (typeof(duration_ms)='integer' AND duration_ms>=0)), PRIMARY KEY(kind,account_id))`
];
const oldNames = ['account_429_cooldowns','ordinary_account_attempts','ordinary_attempts_schema_marker','siwc_account_attempts','siwc_attempts_schema_marker'];
const newNames = ['account_429_v2_schema_marker','account_429_v2_counter','account_429_v2_restrictions'];
const max = 9223372036854775807n;
const bad = () => { throw new Error('Unsafe offline 429 migration'); };
const tokens = sql => {
  if (typeof sql !== 'string' || sql.replace(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),>=]|\s+/g,'') !== '') return null;
  return JSON.stringify(sql.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),>=]/g));
};
function checkObjects(db) {
  const expected = [legacySql,openSql.replace('NAME',oldNames[1]),markerSql.replace('NAME',oldNames[2]),openSql.replace('NAME',oldNames[3]),markerSql.replace('NAME',oldNames[4])];
  const names = [...oldNames,...newNames];
  for (const schema of ['main','temp']) {
    const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema`).all();
    for (const o of objects) {
      const n=names.indexOf(o.name.toLowerCase()), t=names.indexOf(o.tbl_name.toLowerCase());
      if (n>=0 && (schema!=='main' || n>=oldNames.length || o.type!=='table' || o.name!==names[n] || tokens(o.sql)!==tokens(expected[n]))) bad();
      if (t>=0 && o.type!=='table' && !(schema==='main' && t<oldNames.length && [0,1,3].includes(t) && o.type==='index' && o.sql===null && o.name===`sqlite_autoindex_${names[t]}_1`)) bad();
    }
    for (const o of objects.filter(x=>x.type==='table')) {
      const quote='"'+o.name.replace(/"/g,'""')+'"';
      if (db.prepare(`PRAGMA ${schema}.foreign_key_list(${quote})`).all().some(x=>names.includes(x.table.toLowerCase()))) bad();
    }
  }
  for (let i=0;i<oldNames.length;i++) {
    const obj=db.prepare('SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE').get(oldNames[i]);
    if (!obj || obj.name!==oldNames[i] || obj.type!=='table' || tokens(obj.sql)!==tokens(expected[i])) bad();
    const indexes=db.prepare(`PRAGMA main.index_list(${oldNames[i]})`).all();
    if ([0,1,3].includes(i)) {
      if (indexes.length!==1 || indexes[0].name!==`sqlite_autoindex_${oldNames[i]}_1` || indexes[0].unique!==1 || indexes[0].origin!=='pk' || indexes[0].partial!==0) bad();
      const keys=db.prepare(`PRAGMA main.index_xinfo(${indexes[0].name})`).all().filter(x=>x.key===1);
      const cols=i===0 ? ['kind','account_id'] : ['account_id'];
      if (keys.length!==cols.length || keys.some((x,j)=>x.name!==cols[j] || x.coll!=='BINARY' || x.desc!==0)) bad();
    } else if (indexes.length) bad();
  }
  for (const name of [oldNames[2],oldNames[4]]) {
    const r=db.prepare(`SELECT id,version FROM main.${name}`).safeIntegers().all();
    if (r.length!==1 || r[0].id!==1n || r[0].version!==1n) bad();
  }
}
function snapshot(db) {
  const columns=[['kind','account_id','observed_at','until_at','revision'],['account_id','attempt_id'],['id','version'],['account_id','attempt_id'],['id','version']];
  return JSON.stringify(oldNames.map((name,i)=>{
    const projection=columns[i].flatMap(c=>[`typeof(${c})`,`hex(CAST(${c} AS BLOB))`]).join(',');
    return db.prepare(`SELECT ${projection} FROM main.${name} ORDER BY rowid`).raw().all();
  }));
}
/** Internal migration under a trusted, caller-owned top-level IMMEDIATE writer.
 * afterFirstInsert is an optional test fault seam, not an operator interface. */
export function migrateLegacy429(db, afterFirstInsert) {
  if (!db.inTransaction || (afterFirstInsert!==undefined && typeof afterFirstInsert!=='function')) bad();
  if (db.pragma('encoding',{simple:true})!=='UTF-8' || db.pragma('ignore_check_constraints',{simple:true})!==0 || db.pragma('database_list').some(x=>!['main','temp'].includes(x.name))) bad();
  checkObjects(db);
  if (db.pragma('quick_check',{simple:true})!=='ok' || db.pragma('foreign_key_check').length) bad();
  const before=snapshot(db);
  const rows=db.prepare(`SELECT rowid,kind,account_id,typeof(kind) kt,typeof(account_id) it,typeof(observed_at) ot,typeof(until_at) ut,typeof(revision) rt,revision FROM main.account_429_cooldowns ORDER BY rowid`).safeIntegers().all();
  if (BigInt(rows.length)>max) bad();
  const exact=db.prepare('SELECT CAST(kind AS BLOB)=CAST(? AS BLOB) AND CAST(account_id AS BLOB)=CAST(? AS BLOB) ok FROM main.account_429_cooldowns WHERE rowid=?');
  for (const r of rows) {
    if (r.kt!=='text' || r.it!=='text' || !['upstream','siwc'].includes(r.kind) || typeof r.account_id!=='string' || r.ot!=='integer' || r.ut!=='integer' || r.rt!=='integer' || r.revision<=0n || !exact.get(r.kind,r.account_id,r.rowid).ok) bad();
  }
  for (const sql of v2) db.exec(sql.replace('CREATE TABLE ','CREATE TABLE main.'));
  db.prepare('INSERT INTO main.account_429_v2_schema_marker VALUES (1,2)').run();
  db.prepare('INSERT INTO main.account_429_v2_counter VALUES (1,?)').run(BigInt(rows.length));
  const insert=db.prepare('INSERT INTO main.account_429_v2_restrictions VALUES (?,?,?,NULL)');
  for (let i=0;i<rows.length;i++) {
    insert.run(rows[i].kind,rows[i].account_id,BigInt(i)+1n);
    if (i===0 && afterFirstInsert) afterFirstInsert();
  }
  const missing=db.prepare(`SELECT 1 FROM main.account_429_cooldowns l LEFT JOIN main.account_429_v2_restrictions v ON CAST(l.kind AS BLOB)=CAST(v.kind AS BLOB) AND CAST(l.account_id AS BLOB)=CAST(v.account_id AS BLOB) WHERE v.generation IS NULL OR v.duration_ms IS NOT NULL LIMIT 1`).get();
  const result=db.prepare('SELECT count(*) n,count(DISTINCT generation) d,min(generation) lo,max(generation) hi FROM main.account_429_v2_restrictions').safeIntegers().get();
  const count=BigInt(rows.length);
  const counter=db.prepare('SELECT id,generation FROM main.account_429_v2_counter').safeIntegers().all();
  const marker=db.prepare('SELECT id,version FROM main.account_429_v2_schema_marker').safeIntegers().all();
  for (let i=0;i<newNames.length;i++) {
    const obj=db.prepare('SELECT type,name,sql FROM main.sqlite_schema WHERE name=?').get(newNames[i]);
    if (!obj || obj.type!=='table' || obj.name!==newNames[i] || obj.sql!==v2[i]) bad();
  }
  if (counter.length!==1 || counter[0].id!==1n || counter[0].generation!==count || marker.length!==1 || marker[0].id!==1n || marker[0].version!==2n || missing || result.n!==count || result.d!==count || (count>0n && (result.lo!==1n || result.hi!==count)) || snapshot(db)!==before) bad();
}
