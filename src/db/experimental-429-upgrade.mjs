// Disposable in-memory fixture ONLY. Not an application migration or a CLI.
import Database from 'better-sqlite3';
const baseline = [
  ['legacy_cooldowns', 'CREATE TABLE legacy_cooldowns (kind TEXT NOT NULL, account_id TEXT NOT NULL, deadline INTEGER NOT NULL, PRIMARY KEY(kind,account_id))'],
  ['ordinary_account_attempts', 'CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL)'],
  ['siwc_account_attempts', 'CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL)'],
];
const marker = "CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0))";
const restrictions = "CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id))";
const max = 9223372036854775807n;
function text(value, hex) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value,'utf8') <= 512 && Buffer.from(value,'utf8').toString('hex').toUpperCase() === hex;
}
function validate(db) {
  const attached=db.pragma('database_list');
  // Inspecting temp.sqlite_schema may initialize an empty temp database.
  if (db.name !== ':memory:' || attached.some(x=>!['main','temp'].includes(x.name) || x.file !== '') || attached.filter(x=>x.name==='main').length !== 1) throw new Error('Only isolated in-memory synthetic fixtures are supported');
  if (db.pragma('encoding',{simple:true}) !== 'UTF-8' || db.pragma('user_version',{simple:true}) !== 0 || db.pragma('application_id',{simple:true}) !== 0 || db.pragma('ignore_check_constraints',{simple:true}) !== 0) throw new Error('Unexpected metadata');
  const objects=db.prepare('SELECT type,name,sql FROM main.sqlite_schema ORDER BY name').all();
  const expected=[...baseline.map(([name,sql])=>({type:'table',name,sql})), ...baseline.map(([name])=>({type:'index',name:`sqlite_autoindex_${name}_1`,sql:null}))].sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (JSON.stringify(objects)!==JSON.stringify(expected) || db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get()) throw new Error('Unexpected schema or partial upgrade');
  if (db.pragma('integrity_check',{simple:true}) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Invalid database integrity');
  for (const [table,keys] of [['legacy_cooldowns',['kind','account_id']],['ordinary_account_attempts',['account_id']],['siwc_account_attempts',['account_id']]]) {
    const idx=db.pragma(`main.index_list('${table}')`);
    if (idx.length!==1 || idx[0].name!==`sqlite_autoindex_${table}_1` || idx[0].unique!==1 || idx[0].origin!=='pk' || idx[0].partial!==0) throw new Error('Unexpected indexes');
    const cols=db.pragma(`main.index_xinfo('${idx[0].name}')`).filter(x=>x.key===1);
    if (cols.length!==keys.length || cols.some((x,i)=>x.name!==keys[i] || x.coll!=='BINARY' || x.desc!==0)) throw new Error('Unexpected index keys');
  }
  const rows=db.prepare('SELECT kind,account_id,deadline,hex(CAST(kind AS BLOB)) kh,hex(CAST(account_id AS BLOB)) ih FROM main.legacy_cooldowns ORDER BY kind,account_id').safeIntegers().all();
  if (BigInt(rows.length)>max) throw new Error('Counter exhausted');
  for (const r of rows) if (!text(r.kind,r.kh) || !['upstream','siwc'].includes(r.kind) || !text(r.account_id,r.ih) || typeof r.deadline!=='bigint') throw new Error('Malformed legacy row');
  for (const table of ['ordinary_account_attempts','siwc_account_attempts']) {
    for (const r of db.prepare(`SELECT account_id,attempt_id,hex(CAST(account_id AS BLOB)) ih,hex(CAST(attempt_id AS BLOB)) ah FROM main.${table}`).all()) if (!text(r.account_id,r.ih) || !text(r.attempt_id,r.ah)) throw new Error('Malformed OPEN row');
  }
  return rows;
}
function snapshot(db) {
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const names=['legacy_cooldowns','ordinary_account_attempts','siwc_account_attempts','experimental_atomic_429_marker','experimental_atomic_429_restrictions'];
  const rows={};
  for (const name of names) if (schema.some(x=>x.type==='table' && x.name===name)) {
    rows[name]=db.prepare(`SELECT * FROM main.${name} ORDER BY rowid`).safeIntegers().all();
  }
  const indexes={};
  for (const name of names) if (rows[name]) indexes[name]=db.pragma(`main.index_list('${name}')`).map(index=>({ ...index, columns:db.pragma(`main.index_xinfo('${index.name}')`) }));
  return {schema, rows, indexes, temp:db.prepare('SELECT type,name,tbl_name,sql FROM temp.sqlite_schema ORDER BY type,name').all(),
    databases:db.pragma('database_list'), encoding:db.pragma('encoding',{simple:true}),
    userVersion:db.pragma('user_version',{simple:true}), applicationId:db.pragma('application_id',{simple:true}),
    ignoreChecks:db.pragma('ignore_check_constraints',{simple:true}), journalMode:db.pragma('journal_mode',{simple:true})};
}
function parseFixture(json) {
  if (typeof json!=='string') throw new TypeError('Expected a JSON fixture string');
  const fixture=JSON.parse(json);
  if (!fixture || typeof fixture!=='object' || Array.isArray(fixture) || Object.keys(fixture).some(k=>!['legacy','ordinaryOpen','siwcOpen','failAfterWrites'].includes(k))) throw new Error('Unexpected fixture fields');
  for (const [key,width] of [['legacy',3],['ordinaryOpen',2],['siwcOpen',2]]) {
    if (!Array.isArray(fixture[key]) || fixture[key].some(row=>!Array.isArray(row) || row.length!==width || row.some(x=>typeof x!=='string'))) throw new Error(`Invalid ${key} fixture`);
  }
  if (fixture.failAfterWrites!==undefined && typeof fixture.failAfterWrites!=='boolean') throw new Error('Invalid failure flag');
  for (const row of fixture.legacy) {
    if (!/^-?(0|[1-9][0-9]*)$/.test(row[2])) throw new Error('Invalid integer fixture');
    const n=BigInt(row[2]);
    if (n < -9223372036854775808n || n > max) throw new Error('Integer out of range');
  }
  return fixture;
}
// Only inert JSON is accepted; no caller-owned connection, SQL or callback is used.
export function convertSynthetic429(json) {
  if (arguments.length!==1) throw new TypeError('Expected one JSON fixture string');
  const fixture=parseFixture(json);
  const db=new Database(':memory:');
  try {
    db.exec(baseline.map(([,sql])=>sql).join(';')+';');
    const legacy=db.prepare('INSERT INTO legacy_cooldowns VALUES (?,?,?)');
    for (const [kind,id,deadline] of fixture.legacy) legacy.run(kind,id,BigInt(deadline));
    for (const [table,key] of [['ordinary_account_attempts','ordinaryOpen'],['siwc_account_attempts','siwcOpen']]) {
      const insert=db.prepare(`INSERT INTO ${table} VALUES (?,?)`);
      for (const row of fixture[key]) insert.run(...row);
    }
    const before=snapshot(db);
    let wroteBeforeFailure=false;
    let count;
    try {
      count=db.transaction(()=>{
        const rows=validate(db);
        db.exec(marker+';'+restrictions+';');
        db.prepare('INSERT INTO main.experimental_atomic_429_marker VALUES (1,1,?)').run(BigInt(rows.length));
        const insert=db.prepare('INSERT INTO main.experimental_atomic_429_restrictions VALUES (?,?,?,NULL)');
        rows.forEach((r,i)=>insert.run(r.kind,r.account_id,BigInt(i)+1n));
        if (fixture.failAfterWrites) {
          wroteBeforeFailure=Boolean(db.prepare('SELECT 1 FROM main.experimental_atomic_429_marker').get()) && db.prepare('SELECT count(*) n FROM main.experimental_atomic_429_restrictions').get().n===rows.length;
          throw new Error('Injected fixture failure after writes');
        }
        return rows.length;
      }).immediate();
    } catch (error) {
      if (db.inTransaction) throw error;
      return {status:'rejected',reason:error.message,wroteBeforeFailure,before,after:snapshot(db)};
    }
    return {status:'converted',count,before,after:snapshot(db)};
  } finally { db.close(); }
}
