'use strict';
// Review before direct execution. This file is deliberately outside the test glob.
// VM dependency allowlists and JS-level network guards are not a native sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const dgram = require('node:dgram');
const children = require('node:child_process');
const crypto = require('node:crypto');

const denied = () => { throw Error('fixture operation forbidden'); };
net.connect = net.createConnection = net.createServer = denied;
net.Socket.prototype.connect = net.Server.prototype.listen = denied;
tls.connect = tls.createServer = denied;
tls.TLSSocket.prototype.connect = tls.Server.prototype.listen = denied;
http.request = http.get = http.createServer = denied;
https.request = https.get = https.createServer = denied;
for (const key of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']) dns[key] = denied;
for (const key of Object.keys(dns.promises)) if (typeof dns.promises[key] === 'function') dns.promises[key] = denied;
dgram.createSocket = denied;
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) children[key] = denied;
globalThis.fetch = denied;
// The runner is already running; don't expose inherited values to later imports.
process.env = Object.create(null);
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const files = Object.freeze({
  schema: 'src/db/schema.ts',
  v2: 'src/db/account-429-v2-store.ts',
  siwc: 'src/upstream/siwc-store.ts',
  client: 'src/db/client.ts',
  bootstrap: 'scripts/offline-429-upgrade.mjs',
});
function source(key) {
  if (!Object.hasOwn(files, key)) throw Error('source not allowlisted');
  return fs.readFileSync(path.join(root, files[key]), 'utf8');
}
function evaluate(text, imports, filename) {
  const result = ts.transpileModule(text, {reportDiagnostics:true, compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}});
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error('fixture transpilation failed');
  const exports = {};
  const sandbox = vm.createContext({exports, process:Object.freeze({env:Object.freeze({}), argv:Object.freeze([])}), require(name) {
    if (!Object.hasOwn(imports,name)) throw Error('unapproved fixture import: ' + name);
    return imports[name];
  }}, {codeGeneration:{strings:false,wasm:false}});
  new vm.Script(result.outputText, {filename}).runInContext(sandbox, {timeout:1000});
  return exports;
}
const schema = evaluate(source('schema'), Object.create(null), 'fixture-schema.js');
const v2 = evaluate(source('v2'), Object.create(null), 'fixture-v2.js');
const siwc = evaluate(source('siwc'), {'node:crypto':crypto, 'better-sqlite3':{__esModule:true, default:denied}}, 'fixture-siwc.js');

// Replace only ESM module initialization (top-level await/import.meta) with
// explicitly injected dependencies; the actual exported helper body is intact.
const bootstrapSource = source('bootstrap');
const boundary = '// Only this last committed legacy DDL';
assert.equal(bootstrapSource.split(boundary).length, 2);
const bootstrapPreamble = `const fs = require('fixture:reserved-fs');
const path = require('fixture:path');
const REQUIRED = ['--backup-verified', '--all-routers-stopped', '--no-outstanding-work', '--legacy-schema-provenance-verified', '--single-host-trusted-directory'];
const OPERATIONALLY_ENABLED = false;
const direct = false;
const {migrateLegacy429, assert429V2Schema, assertTokenUsageSchema, SQL_SCHEMA} = require('fixture:bootstrap-deps');
`;
const bootstrap = evaluate(bootstrapPreamble + boundary + bootstrapSource.split(boundary)[1], {
  'fixture:reserved-fs':Object.freeze({}), 'fixture:path':path.posix,
  'fixture:bootstrap-deps':{migrateLegacy429:denied, assert429V2Schema:v2.assert429V2Schema, assertTokenUsageSchema:schema.assertTokenUsageSchema, SQL_SCHEMA:schema.SQL_SCHEMA},
}, 'fixture-bootstrap.js');

const target = '/trusted/new.db'; // lexical fake only; never passed to real fs or SQLite
const args = ['--brand-new-database-provenance-verified','--all-routers-stopped','--single-host-trusted-directory',target];
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name));
}
function makeClient(db) {
  const observed = {constructors:0, usage:[], v2:0, siwc:0, provision:0};
  function FakeDatabase(name, options) {
    observed.constructors++;
    assert.equal(name, ':memory:');
    assert.equal(options.fileMustExist, true);
    assert.equal(options.timeout, 5000);
    return db;
  }
  const actualInitialize = siwc.SiwcStore.initialize;
  const siwcWrapper = {initialize(handle) { observed.siwc++; assert.equal(handle,db); return actualInitialize.call(siwc.SiwcStore,handle); }};
  const api = evaluate(source('client'), {
    'better-sqlite3':{__esModule:true, default:FakeDatabase},
    '../config/env.js':{env:Object.freeze({DATABASE_URL:'sqlite::memory:'})},
    '../utils/logger.js':{logger:{info(){}}},
    './schema.js':{...schema, assertTokenUsageSchema(handle, allowAbsent) {
      assert.equal(handle,db);
      const before = tableExists(db,'usage_logs');
      const result = schema.assertTokenUsageSchema(handle,allowAbsent);
      const after = tableExists(db,'usage_logs');
      observed.usage.push({allowAbsent:allowAbsent === true, before, after, inTransaction:db.inTransaction});
      return result;
    }},
    '../upstream/siwc-store.js':{SiwcStore:siwcWrapper},
    './account-429-v2-store.js':{...v2, assert429V2Schema(handle) {observed.v2++; return v2.assert429V2Schema(handle);}},
  }, 'fixture-client.js');
  return {api,observed};
}
function fakeAdapters(db, c) {
  let created=false, closed=false, fdClosed=false;
  const dir = ino => ({dev:1n,ino,nlink:1n,isSymbolicLink:()=>false,isFile:()=>false,isDirectory:()=>true});
  const file = {dev:1n,ino:3n,nlink:1n,isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>false};
  const io = {
    lstatSync(p) {if(p==='/') return dir(1n); if(p==='/trusted') return dir(2n); if(p===target && created) return file; throw Error('fake fs path forbidden');},
    openSync(p,mode,perm) {assert.equal(p,target); assert.equal(mode,'wx'); assert.equal(perm,0o600); assert.equal(created,false); created=true; return 99;},
    fstatSync(fd) {assert.equal(fd,99); return file;},
    closeSync(fd) {assert.equal(fd,99); assert.equal(fdClosed,false); fdClosed=true;},
  };
  const wrapped = new Proxy(db, {get(obj,key) {
    if(key==='close') return () => {assert.equal(closed,false); closed=true;};
    if(key==='open') return !closed;
    const value=obj[key]; return typeof value==='function' ? value.bind(obj) : value;
  }});
  return {deps:{fs:io,path:path.posix,platform:'linux',openDatabase(p,opts) {
    assert.equal(p,target); assert.equal(opts.fileMustExist,true); assert.equal(opts.timeout,1000); return wrapped;
  }, provision(handle) {c.observed.provision++; assert.equal(handle,wrapped); return c.api.provisionFreshSafetySchema(handle);}},
  state:()=>({created,closed,fdClosed})};
}

test('real fresh preprovisioning permits real initialization of an empty in-memory database', () => {
  const db = new Database(':memory:');
  try {
    assert.equal(db.memory,true);
    assert.equal(db.name,':memory:');
    assert.equal(db.prepare('SELECT count(*) n FROM main.sqlite_schema').get().n,0);
    const c=makeClient(db), h=fakeAdapters(db,c);
    bootstrap.runFreshBootstrap(args,h.deps);
    assert.deepEqual(h.state(),{created:true,closed:true,fdClosed:true});
    assert.equal(c.observed.provision,1);
    assert.equal(db.open,true);
    assert.equal(tableExists(db,'usage_logs'),false);
    assert.equal(c.api.validateOrdinaryProvisioning(db),true);
    assert.equal(c.api.validateSiwcProvisioning(db),true);
    assert.equal(v2.assert429V2Schema(db),0n);
    assert.equal(c.api.initDatabase(),db);
    assert.equal(c.api.requireInitializedDatabase(),db);
    assert.deepEqual(c.observed.usage,[
      {allowAbsent:true,before:false,after:false,inTransaction:false},
      {allowAbsent:true,before:false,after:false,inTransaction:true},
      {allowAbsent:false,before:true,after:true,inTransaction:true},
    ]);
    assert.equal(c.observed.constructors,1);
    assert.equal(c.observed.v2,3); // provisioning and two startup checks
    assert.equal(c.observed.siwc,1);
    assert.equal(tableExists(db,'usage_logs'),true);
    schema.assertTokenUsageSchema(db);
    assert.equal(v2.assert429V2Schema(db),0n);
    assert.equal(c.api.validateOrdinaryProvisioning(db),true);
    assert.equal(c.api.validateSiwcProvisioning(db),true);
    for(const name of ['users','upstream_accounts','siwc_credentials','ordinary_account_attempts','siwc_account_attempts']) assert.equal(tableExists(db,name),true);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally {if(db.open) db.close();}
});

test('fresh empty database missing v2 is refused before application schema creation', () => {
  const db=new Database(':memory:');
  try {
    assert.equal(db.memory,true);
    assert.equal(db.name,':memory:');
    assert.equal(db.prepare('SELECT count(*) n FROM main.sqlite_schema').get().n,0);
    let sqlSchemaCalls=0, objectsAtClose;
    const watched=new Proxy(db, {get(obj,key) {
      if(key==='exec') return sql => {if(sql===schema.SQL_SCHEMA) sqlSchemaCalls++; return obj.exec(sql);};
      if(key==='close') return () => {objectsAtClose=obj.prepare('SELECT count(*) n FROM main.sqlite_schema').get().n; return obj.close();};
      const value=obj[key]; return typeof value==='function' ? value.bind(obj) : value;
    }});
    const c=makeClient(watched);
    assert.throws(()=>c.api.initDatabase(), e=>e && e.message==='Unsafe 429 v2 schema');
    assert.equal(sqlSchemaCalls,0);
    assert.equal(objectsAtClose,0);
    assert.equal(c.observed.constructors,1);
    assert.equal(c.observed.v2,1);
    assert.equal(c.observed.usage.length,0);
    assert.equal(c.observed.siwc,0);
    // initDatabase closes its owned connection on preflight rejection.
    assert.equal(db.open,false);
  } finally {if(db.open) db.close();}
});
