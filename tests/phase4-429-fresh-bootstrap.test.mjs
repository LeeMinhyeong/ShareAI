import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as v2 from '../src/db/account-429-v2-store.ts';
import {SQL_SCHEMA, assertTokenUsageSchema} from '../src/db/schema.ts';
import {SiwcStore} from '../src/upstream/siwc-store.ts';
import {runFreshBootstrap} from '../scripts/offline-429-upgrade.mjs';

const flags = ['--brand-new-database-provenance-verified','--all-routers-stopped','--single-host-trusted-directory'];
const filename = '/trusted/new.db';
const args = [...flags, filename];
// The VM imports only these explicit fake or side-effect-free dependencies.
const source = readFileSync(new URL('../src/db/client.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {reportDiagnostics:true, compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}});
if (transpiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error('client fixture transpilation failed');
const compiled = transpiled.outputText;
function client(db) {
  const exports = {};
  const imports = {
    'better-sqlite3': {__esModule:true, default:class { constructor(name, opts) { assert.equal(name, filename); assert.equal(opts.fileMustExist, true); return db; } }},
    '../config/env.js': {env:{DATABASE_URL:`sqlite:${filename}`}},
    '../utils/logger.js': {logger:{info(){}}}, './schema.js': {SQL_SCHEMA, assertTokenUsageSchema},
    '../upstream/siwc-store.js': {SiwcStore}, './account-429-v2-store.js': v2,
  };
  const context = vm.createContext({exports, process:new Proxy({}, {get(){throw Error('process access forbidden');}}), require(name) { if (!Object.hasOwn(imports, name)) throw Error('unapproved import'); return imports[name]; }, AggregateError});
  new vm.Script(compiled, {filename:'isolated-client.js'}).runInContext(context);
  return exports;
}
function fixture({exists=false, provisionHook, onMarker}={}) {
  const db = new Database(':memory:');
  const actual = client(db);
  let existsNow = exists, touched=0, closeCount=0, bootstrapClosed=false;
  const dir = (ino) => ({dev:1n,ino,nlink:1n,isSymbolicLink:()=>false,isFile:()=>false,isDirectory:()=>true});
  const file = {dev:1n,ino:3n,nlink:1n,isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>false};
  const io = {
    lstatSync(p) { touched++; if(p==='/') return dir(1n); if(p==='/trusted') return dir(2n); if(p===filename && existsNow) return file; throw Error('unexpected path'); },
    openSync(p, mode, perm) { touched++; assert.equal(p,filename); assert.equal(mode,'wx'); assert.equal(perm,0o600); if(existsNow) { const e=Error('exists'); e.code='EEXIST'; throw e; } existsNow=true; return 99; },
    fstatSync(fd) { assert.equal(fd,99); return file; }, closeSync(fd) { assert.equal(fd,99); closeCount++; },
  };
  const wrapped = new Proxy(db, {get(target, prop) {
    if (prop === 'close') return () => {bootstrapClosed=true;};
    if (prop === 'open') return !bootstrapClosed;
    if (prop === 'prepare' && onMarker) return sql => {
      const stmt = target.prepare(sql);
      if (sql !== 'INSERT INTO main.account_429_v2_schema_marker VALUES (1, 2)') return stmt;
      return {run(...params) { const result = stmt.run(...params); onMarker(target); return result; }};
    };
    const value=target[prop]; return typeof value==='function' ? value.bind(target) : value;
  }});
  const dependencies = {fs:io,path:path.posix,platform:'linux', openDatabase:(p,opts) => {assert.equal(p,filename); assert.equal(opts.fileMustExist,true); return wrapped;}, provision: provisionHook ? d => provisionHook(d,actual) : actual.provisionFreshSafetySchema};
  return {db,actual,dependencies,get touched(){return touched;},get closeCount(){return closeCount;},get exists(){return existsNow;}};
}

test('fresh preprovisioning enables actual isolated client startup', () => {
  const f=fixture();
  try {
    runFreshBootstrap(args,f.dependencies);
    assert.equal(f.actual.validateOrdinaryProvisioning(f.db),true);
    assert.equal(f.actual.validateSiwcProvisioning(f.db),true);
    assert.equal(v2.assert429V2Schema(f.db),0n);
    assert.deepEqual(f.db.prepare('SELECT * FROM ordinary_attempts_schema_marker').all(),[{id:1,version:1}]);
    assert.deepEqual(f.db.prepare('SELECT * FROM siwc_attempts_schema_marker').all(),[{id:1,version:1}]);
    assert.equal(f.closeCount,1);
    assert.equal(f.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='usage_logs'").get(),undefined);
    assert.equal(f.actual.initDatabase(),f.db);
    assert.ok(f.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='usage_logs'").get());
    assert.doesNotThrow(()=>assertTokenUsageSchema(f.db));
    assert.equal(f.actual.requireInitializedDatabase(),f.db);
    assert.ok(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='upstream_accounts'").get());
    assert.ok(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='siwc_credentials'").get());
  } finally { if(f.db.open) f.db.close(); }
});
test('attestations and path are checked before filesystem access', () => {
  const f=fixture(); try {
    assert.throws(()=>runFreshBootstrap(flags.slice(1).concat(filename),f.dependencies),/attestations/);
    assert.throws(()=>runFreshBootstrap([...flags,'/trusted/../bad'],f.dependencies),/absolute/);
    assert.equal(f.touched,0);
  } finally {f.db.close();}
});
test('exclusive creation refuses an existing target', () => {
  const f=fixture({exists:true}); try {
    f.dependencies.openDatabase=()=>{throw Error('must not open');};
    assert.throws(()=>runFreshBootstrap(args,f.dependencies), e=>e instanceof AggregateError && e.errors[0].code==='EEXIST');
    assert.equal(f.exists,true); assert.equal(f.closeCount,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM sqlite_schema').get().n,0);
  } finally {f.db.close();}
});
test('nonempty and TEMP-conflicting databases are rejected before provisioning', () => {
  for (const sql of ['CREATE TABLE unrelated(x)', 'CREATE TEMP TABLE unrelated(x)']) {
    const f=fixture(); try {
      f.db.exec(sql);
      assert.ok(f.db.prepare("SELECT 1 FROM " + (sql.includes('TEMP') ? 'temp' : 'main') + ".sqlite_schema WHERE name='unrelated'").get());
      assert.throws(()=>runFreshBootstrap(args,f.dependencies), e => e instanceof AggregateError && e.errors[0]?.message === 'Fresh provisioning requires an empty, unattached database');
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name LIKE 'account_429_v2_%'").get().n,0);
    } finally {f.db.close();}
  }
});
test('attached database is rejected before provisioning', () => {
  const f=fixture(); try {
    f.db.exec("ATTACH DATABASE ':memory:' AS extra");
    assert.ok(f.db.pragma('database_list').some(entry => entry.name === 'extra'));
    assert.throws(()=>runFreshBootstrap(args,f.dependencies), e => e instanceof AggregateError && e.errors[0]?.message === 'Fresh provisioning requires an empty, unattached database');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM main.sqlite_schema").get().n,0);
  } finally {f.db.close();}
});
test('first successful v2 marker insert rolls back the complete fresh schema', () => {
  const injectedError = Error('synthetic marker fault');
  let observed;
  const f=fixture({onMarker: db => { observed={inTransaction:db.inTransaction, rows:db.prepare('SELECT * FROM main.account_429_v2_schema_marker').all(), counter:db.prepare('SELECT * FROM main.account_429_v2_counter').all()}; throw injectedError; }});
  const schema = f.db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  try {
    assert.throws(()=>runFreshBootstrap(args,f.dependencies),e => e instanceof AggregateError && e.errors[0] === injectedError);
    assert.deepEqual(observed,{inTransaction:true, rows:[{id:1,version:2}], counter:[]});
    assert.equal(f.db.inTransaction,false);
    assert.deepEqual(f.db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all(),schema);
    assert.equal(f.db.prepare("SELECT count(*) n FROM main.sqlite_schema WHERE name LIKE 'account_429_v2_%' OR name LIKE '%attempts%'").get().n,0);
    assert.equal(f.exists,true); assert.equal(f.closeCount,1);
  } finally {f.db.close();}
});

test('fresh Windows lexical paths reject invalid and accept fully qualified forms', () => {
  const f=fixture();
  try {
    let touched=0;
    const stop=Error('synthetic root reached');
    f.dependencies.path=path.win32; f.dependencies.platform='win32';
    f.dependencies.fs={lstatSync(p) { if (!['C:\\', '\\\\server\\share\\'].includes(p)) throw Error('path not allowlisted'); touched++; throw stop; }};
    for (const input of ['C:relative.db','\\safe\\file.db','C:\\safe\\..\\file.db','C:\\safe\\.\\file.db','C:\\safe\\file.db\\','C:\\safe\\bad.','C:\\safe\\NUL.db','\\\\?\\C:\\safe\\file.db']) {
      const before=touched;
      assert.throws(()=>runFreshBootstrap([...flags,input],f.dependencies), e=>e.message==='An absolute database path is required');
      assert.equal(touched,before);
    }
    for (const input of ['C:\\safe\\file.db','C:/safe/file.db','\\\\server\\share\\file.db']) {
      const before=touched;
      assert.throws(()=>runFreshBootstrap([...flags,input],f.dependencies),e=>e===stop);
      assert.equal(touched,before+1);
    }
  } finally {f.db.close();}
});

test('synthetic symlink ancestor is refused before creation', () => {
  const f=fixture(); try {
    const original=f.dependencies.fs.lstatSync;
    f.dependencies.fs.lstatSync=p=>p==='/trusted' ? {dev:1n,ino:2n,isSymbolicLink:()=>true,isDirectory:()=>true} : original(p);
    assert.throws(()=>runFreshBootstrap(args,f.dependencies),e=>e.message==='Unsafe database path');
    assert.equal(f.exists,false); assert.equal(f.closeCount,0);
  } finally {f.db.close();}
});

test('synthetic Windows reparse-like ancestor is refused before creation', () => {
  const f=fixture(); let openCalls=0;
  try {
    f.dependencies.path=path.win32; f.dependencies.platform='win32';
    f.dependencies.fs={lstatSync(p) {
      if (p==='C:\\') return {dev:1n,ino:1n,isSymbolicLink:()=>false,isDirectory:()=>true};
      if (p==='C:\\trusted') return {dev:1n,ino:2n,isSymbolicLink:()=>true,isDirectory:()=>true};
      throw Error('path not allowlisted');
    }, openSync(){openCalls++; throw Error('unexpected creation');}};
    assert.throws(()=>runFreshBootstrap([...flags,'C:\\trusted\\new.db'],f.dependencies),e=>e.message==='Unsafe database path');
    assert.equal(openCalls,0); assert.equal(f.db.prepare('SELECT count(*) n FROM main.sqlite_schema').get().n,0);
  } finally {f.db.close();}
});

test('identity changes before and after SQLite open are refused', () => {
  for (const stage of ['before','after']) {
    const f=fixture(); try {
      const original=f.dependencies.fs.fstatSync, open=f.dependencies.openDatabase;
      let stats=0, opened=0;
      f.dependencies.fs.fstatSync=fd=>{const st=original(fd); stats++; return (stage==='before' && stats===1) || (stage==='after' && opened) ? {...st,ino:9n} : st;};
      f.dependencies.openDatabase=(...a)=>{opened++; return open(...a);};
      assert.throws(()=>runFreshBootstrap(args,f.dependencies),e=>e instanceof AggregateError && e.errors[0]?.message===(stage==='before'?'Database identity changed':'Database path changed'));
      assert.equal(opened,stage==='before'?0:1); assert.equal(f.exists,true); assert.equal(f.closeCount,1);
      assert.equal(f.db.prepare('SELECT count(*) n FROM main.sqlite_schema').get().n,0);
    } finally {f.db.close();}
  }
});

test('cleanup failure retains created path and both exact errors', () => {
  const primary=Error('synthetic primary'), cleanup=Error('synthetic cleanup');
  const f=fixture({provisionHook:()=>{throw primary;}});
  try {
    f.dependencies.fs.closeSync=fd=>{assert.equal(fd,99); throw cleanup;};
    assert.throws(()=>runFreshBootstrap(args,f.dependencies),e=>e instanceof AggregateError && e.errors.length===2 && e.errors[0]===primary && e.errors[1]===cleanup && e.message.startsWith('Created path retained'));
    assert.equal(f.exists,true); assert.equal(f.db.inTransaction,false);
    assert.equal(f.db.prepare('SELECT count(*) n FROM main.sqlite_schema').get().n,0);
  } finally {f.db.close();}
});

test('ambient SQLite transaction is rejected before provisioning', () => {
  const f=fixture(); let called=0;
  try {
    f.db.exec('BEGIN'); assert.equal(f.db.inTransaction,true);
    f.dependencies.provision=()=>{called++;};
    assert.throws(()=>runFreshBootstrap(args,f.dependencies),e=>e instanceof AggregateError && e.errors[0]?.message==='Top-level transaction required');
    assert.equal(called,0); assert.equal(f.db.inTransaction,true); assert.equal(f.exists,true);
  } finally {if(f.db.inTransaction) f.db.exec('ROLLBACK'); f.db.close();}
});

test('direct fresh bootstrap is hard-disabled with empty environment', () => {
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/offline-429-upgrade.mjs',import.meta.url)),'--fresh-bootstrap'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{},encoding:'utf8',timeout:5000,maxBuffer:4096,windowsHide:true});
  assert.equal(child.error===undefined,true,'child spawn or timeout failure');
  assert.equal(child.signal,null); assert.equal(typeof child.status==='number' && child.status!==0,true);
  assert.equal(child.stdout,'');
  assert.equal(child.stderr.trim()==='Fresh bootstrap is disabled pending independent review and explicit authorization.',true);
});
