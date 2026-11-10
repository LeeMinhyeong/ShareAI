// Offline operator tool. Never imported by router startup.
import Database from 'better-sqlite3';
import { lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import path from 'node:path';

const auditSQL = `CREATE TABLE offline_open_recovery_audit (id INTEGER PRIMARY KEY, happened_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ordinary','siwc')), account_id TEXT NOT NULL, attempt_id TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('REMOTE_COMPLETED','REMOTE_NOT_STARTED')), status TEXT NOT NULL CHECK(status='CLEARED')) STRICT;
CREATE TABLE offline_open_recovery_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)) STRICT;
CREATE TRIGGER offline_open_audit_no_update BEFORE UPDATE ON offline_open_recovery_audit BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER offline_open_audit_no_delete BEFORE DELETE ON offline_open_recovery_audit BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER offline_open_audit_no_replace BEFORE INSERT ON offline_open_recovery_audit WHEN EXISTS (SELECT 1 FROM offline_open_recovery_audit WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER offline_open_marker_no_update BEFORE UPDATE ON offline_open_recovery_marker BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER offline_open_marker_no_delete BEFORE DELETE ON offline_open_recovery_marker BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER offline_open_marker_no_insert BEFORE INSERT ON offline_open_recovery_marker WHEN EXISTS (SELECT 1 FROM offline_open_recovery_marker) BEGIN SELECT RAISE(ABORT,'immutable'); END;`;
const fenceSQL = kind => `CREATE TABLE ${kind}_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL); CREATE TABLE ${kind}_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));`;
const token = s => s === null ? null : JSON.stringify(s.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g));
const safeId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(s);
const attempt = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(s);
const timestamp = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$(?![\s\S])/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s;
const safety = ['--routers-stopped','--provider-no-inflight','--backup-verified','--accept-unverified-remote-evidence'];
function parse(args) {
  const command=args.shift();
  if (!['inspect','initialize-audit','recover'].includes(command)) throw Error();
  const valueOptions = command === 'recover' ? ['--db','--kind','--account-id','--attempt-id','--actor','--reason'] : ['--db'];
  const flags = command === 'inspect' ? [] : [...safety, ...(command === 'initialize-audit' ? ['--audit-never-provisioned'] : [])];
  const values = {};
  while (args.length) { const key=args.shift(); if (Object.hasOwn(values,key)) throw Error(); if (valueOptions.includes(key)) { const v=args.shift(); if (!v || v.startsWith('--')) throw Error(); values[key]=v; } else if (flags.includes(key)) values[key]=true; else throw Error(); }
  if ([...valueOptions,...flags].some(k => !Object.hasOwn(values,k))) throw Error();
  if (command === 'recover' && (!['ordinary','siwc'].includes(values['--kind']) || !safeId(values['--account-id']) || !attempt(values['--attempt-id']) || !safeId(values['--actor']) || !['REMOTE_COMPLETED','REMOTE_NOT_STARTED'].includes(values['--reason']))) throw Error();
  return {command,values};
}
function identity(input) {
  if (/^file:/i.test(input) || input.includes('\0')) throw Error();
  const absolute=path.resolve(input), root=path.parse(absolute).root;
  let current=root; const components=[root,...absolute.slice(root.length).split(path.sep).filter(Boolean)];
  return components.map((part,i)=>{ if(i) current=path.join(current,part); const s=lstatSync(current,{bigint:true}); if(s.isSymbolicLink() || (i<components.length-1 ? !s.isDirectory() : !s.isFile() || s.nlink!==1n) || s.ino===0n) throw Error(); return `${s.dev}:${s.ino}`; });
}
function objects(db,names) {
  const placeholders=names.map(()=>'?').join(',');
  return db.prepare(`SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name COLLATE NOCASE IN (${placeholders}) OR tbl_name COLLATE NOCASE IN (${placeholders}) ORDER BY type,name`).all(...names,...names).map(o=>({...o,sql:token(o.sql)}));
}
function validateObjects(db, sql, names) {
  const ref=new Database(':memory:'); try { ref.exec(sql); if(JSON.stringify(objects(db,names))!==JSON.stringify(objects(ref,names))) throw Error(); } finally { ref.close(); }
  for (const {name} of db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all()) {
    const quoted='"'+name.replaceAll('"','""')+'"';
    if(db.prepare(`PRAGMA main.foreign_key_list(${quoted})`).all().some(f=>names.includes(f.table.toLowerCase()))) throw Error();
  }
}
function validateFence(db,kind) {
  const table=`${kind}_account_attempts`, marker=`${kind}_attempts_schema_marker`;
  validateObjects(db,fenceSQL(kind),[table,marker]);
  const rows=db.prepare(`SELECT id,version FROM main.${marker}`).all();
  if(rows.length!==1 || rows[0].id!==1 || rows[0].version!==1) throw Error();
  const result=db.prepare(`SELECT account_id,attempt_id FROM main.${table}`).all();
  if(result.some(r=>!safeId(r.account_id)||!attempt(r.attempt_id))) throw Error();
  return result.map(r=>({kind,account_id:r.account_id,attempt_id:r.attempt_id}));
}
function validateAudit(db) {
  validateObjects(db,auditSQL,['offline_open_recovery_audit','offline_open_recovery_marker']);
  const marker=db.prepare('SELECT id,version FROM main.offline_open_recovery_marker').all();
  if(marker.length!==1 || marker[0].id!==1 || marker[0].version!==1) throw Error();
  const rows=db.prepare('SELECT id,happened_at,kind,account_id,attempt_id,actor,reason,status FROM main.offline_open_recovery_audit').all();
  if(rows.some(r=>!Number.isSafeInteger(r.id)||r.id<1 || !timestamp(r.happened_at) || !['ordinary','siwc'].includes(r.kind) || !safeId(r.account_id) || !attempt(r.attempt_id) || !safeId(r.actor) || !['REMOTE_COMPLETED','REMOTE_NOT_STARTED'].includes(r.reason) || r.status!=='CLEARED')) throw Error();
}
let db,fd;
try {
  const {command,values}=parse(process.argv.slice(2));
  console.error('WARNING: Unknown remote outcome can duplicate work or charges. Do not recover unless external state is confirmed and all routers are stopped. Attestations are not proof; SQLite cannot prevent a later reconnect. Protect the path from replacement.');
  const file=values['--db'], before=identity(file), target=path.resolve(file);
  fd=openSync(target,constants.O_RDONLY | (process.platform==='win32'?0:(constants.O_NOFOLLOW||0)));
  const st=fstatSync(fd,{bigint:true}); if(!st.isFile() || st.nlink!==1n || `${st.dev}:${st.ino}`!==before.at(-1)) throw Error();
  const check=()=>{const current=fstatSync(fd,{bigint:true});if(!current.isFile() || current.nlink!==1n || `${current.dev}:${current.ino}`!==before.at(-1) || JSON.stringify(identity(file))!==JSON.stringify(before)) throw Error();};
  check(); db=new Database(target,{fileMustExist:true,readonly:command==='inspect',timeout:3000}); check();
  db.pragma('recursive_triggers = ON');
  const operation=()=>{
    check();
    if(db.pragma('quick_check',{simple:true})!=='ok' || db.pragma('foreign_key_check').length) throw Error();
    const opens=[...validateFence(db,'ordinary'),...validateFence(db,'siwc')];
    if(command==='inspect') return opens;
    if(command==='initialize-audit') {
      const collisions=db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name LIKE 'offline_open_%' OR tbl_name LIKE 'offline_open_%' LIMIT 1").get();
      if(collisions) throw Error();
      db.exec(auditSQL); db.exec('INSERT INTO main.offline_open_recovery_marker VALUES (1,1)'); validateAudit(db);
    } else {
      validateAudit(db);
      const kind=values['--kind'], account=values['--account-id'], id=values['--attempt-id'];
      const changed=db.prepare(`DELETE FROM main.${kind}_account_attempts WHERE account_id=? AND attempt_id=?`).run(account,id);
      if(changed.changes!==1) throw Error();
      db.prepare("INSERT INTO main.offline_open_recovery_audit (happened_at,kind,account_id,attempt_id,actor,reason,status) VALUES (?,?,?,?,?,?,'CLEARED')").run(new Date().toISOString(),kind,account,id,values['--actor'],values['--reason']);
    }
    check();
  };
  const result=command==='inspect' ? db.transaction(operation).deferred() : db.transaction(operation).immediate();
  if(command==='inspect') console.log(JSON.stringify(result)); else console.log(command==='recover'?'Recovery committed.':'Audit initialized.');
} catch {
  console.error('Offline operation refused or failed. If commit outcome is uncertain, inspect the database and verified backup before proceeding.'); process.exitCode=1;
} finally { if(db) db.close(); if(fd!==undefined) closeSync(fd); }
