import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (process.argv[2] !== '--offline-app-schema-child') {
  test('isolated application schema migration cases', async () => {
    const root=process.env.TMPDIR;
    assert.ok(typeof root==='string' && path.isAbsolute(root),'absolute TMPDIR required');
    const owned=fs.mkdtempSync(path.join(fs.realpathSync(root),'shareai-offline-suite-'));
    let closed=false;
    try {
    const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(import.meta.url),'--offline-app-schema-child'],{env:{FIXTURE_ROOT:owned,SystemRoot:process.env.SystemRoot ?? ''},stdio:['ignore','pipe','pipe']});
    let output='', size=0, timedOut=false, overflow=false, spawnError, streamError, closureTimer;
    const collect=chunk=>{size+=chunk.length; if(size>65536){overflow=true;child.kill();}else output+=chunk.toString();};
    child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',e=>{spawnError=e;});
    child.stdout.on('error',e=>{streamError=e;});child.stderr.on('error',e=>{streamError=e;});
    let rejectClosure;
    const closure=new Promise((resolve,reject)=>{rejectClosure=reject;child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
    const timer=setTimeout(()=>{timedOut=true;child.kill();closureTimer=setTimeout(()=>rejectClosure(new Error('child close unconfirmed')),5000);},30000);
    let result;try {result=await closure;} finally {clearTimeout(timer);clearTimeout(closureTimer);}
    assert.equal(Boolean(spawnError),false,'child spawn failed');assert.equal(timedOut,false,'child timed out');assert.equal(overflow,false,'child output limit exceeded');
    assert.equal(Boolean(streamError),false,'child stream error');
    assert.equal(result.code,0,`child failed: ${output}`);
    assert.equal(result.signal,null,'child terminated by signal');
    assert.equal(output.split('OFFLINE_APP_SCHEMA_SUCCESS:10').length-1,1,'missing child completion marker');
    } finally {
      if(closed) fs.rmSync(owned,{recursive:true});
      else console.error(`Fixture child close unconfirmed; retained: ${owned}`);
    }
  });
} else {
// Only builtins and the tsx loader precede these guards; VM is not a sandbox.
const denied = () => { throw new Error('network disabled in fixture'); };
net.connect = net.createConnection = denied;
net.createServer = denied;
net.Socket.prototype.connect = denied;
net.Server.prototype.listen = denied;
tls.connect = tls.createServer = denied;
tls.TLSSocket.prototype.connect = denied;
tls.Server.prototype.listen = denied;
http.request = http.get = https.request = https.get = denied;
globalThis.fetch = denied;
const [{default: Database}, ts, schema, {SiwcStore}, v2, {runOffline429}] = await Promise.all([
  import('better-sqlite3'), import('typescript'), import('../src/db/schema.ts'),
  import('../src/upstream/siwc-store.ts'), import('../src/db/account-429-v2-store.ts'),
  import('../scripts/offline-429-upgrade.mjs')
]);
const clientSource = readFileSync(new URL('../src/db/client.ts', import.meta.url), 'utf8');
const current = `CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  upstream_account_id TEXT NOT NULL,
  
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  
  input_tokens INTEGER,
  output_tokens INTEGER,
  usage_known INTEGER CHECK (usage_known IS NULL OR usage_known IN (0, 1)),
  
  success BOOLEAN NOT NULL,
  error TEXT,
  
  latency_ms INTEGER NOT NULL,

  CHECK ((input_tokens IS NULL AND output_tokens IS NULL AND usage_known IS 0) OR
    (typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer' AND input_tokens >= 0 AND output_tokens >= 0 AND input_tokens <= 9007199254740991 AND output_tokens <= 9007199254740991 AND input_tokens + output_tokens <= 9007199254740991 AND usage_known IS 1) OR
    (usage_known IS NULL AND typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer')),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE
);`;
assert.equal(schema.SQL_SCHEMA.split(current).length - 1,1);
// Only legacy usage DDL is from Phase2 740df936887f40efc727a24b159064bfd4db34e5.
// Other objects come from the current client, not a complete historical schema.
const legacy = `CREATE TABLE IF NOT EXISTS usage_logs (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,upstream_account_id TEXT NOT NULL,timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,model TEXT NOT NULL,provider TEXT NOT NULL,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,success BOOLEAN NOT NULL,error TEXT,latency_ms INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE);`;
const oldSchema = schema.SQL_SCHEMA.replace(current, legacy);
for (const needle of ['assert429V2Schema(dbInstance);','assert429V2Schema(dbInstance!);','assertTokenUsageSchema(dbInstance, true);','assertTokenUsageSchema(dbInstance!);']) assert.equal(clientSource.split(needle).length - 1, 1);
const js = ts.transpileModule(clientSource, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
// The injected database is an in-memory SQLite handle, but the configured path must be a plain file
// path: the client refuses in-memory paths (ADR 0018). FakeDatabase never touches the file system.
function client(db, historical, dbPath='synthetic-offline.db') {
  let c429=0, usage=0, constructors=0;
  function FakeDatabase(p, opts) { constructors++; assert.equal(p, dbPath); assert.equal(opts.fileMustExist,true); return db; }
  const imports = {
    'better-sqlite3': {default: FakeDatabase},
    '../config/env.js': {env:{DATABASE_URL:`sqlite:${dbPath}`}},
    '../utils/logger.js': {logger:{info(){}}},
    './schema.js': {...schema, SQL_SCHEMA:historical ? oldSchema : schema.SQL_SCHEMA, assertTokenUsageSchema:(...args)=>{usage++; if (!historical) return schema.assertTokenUsageSchema(...args);}},
    '../upstream/siwc-store.js': {SiwcStore},
    './account-429-v2-store.js': {...v2, assert429V2Schema:(...args)=>{c429++; if (!historical) return v2.assert429V2Schema(...args);}},
  };
  const exports = {};
  const context = vm.createContext({exports, require:(name)=>{ assert.ok(Object.hasOwn(imports,name), `unexpected dependency ${name}`); return imports[name]; }, process:Object.freeze({env:Object.freeze({})})}, {codeGeneration:{strings:false,wasm:false}});
  new vm.Script(js).runInContext(context, {timeout:1000});
  return {api:exports, counts:()=>({c429,usage,constructors})};
}
const flags = ['--backup-verified','--all-routers-stopped','--no-outstanding-work','--legacy-schema-provenance-verified','--single-host-trusted-directory'];
const target='/safe/router.db';
function fixture(foreignKeys) {
  const db = new Database(':memory:');
  assert.equal(db.memory, true);
  assert.equal(db.prepare('SELECT count(*) n FROM sqlite_schema').get().n, 0);
  const c=client(db,true);
  assert.equal(c.api.validateOrdinaryProvisioning(db),false);
  assert.equal(c.api.validateSiwcProvisioning(db),false);
  assert.equal(c.api.initDatabase(),db);
  assert.deepEqual(c.counts(),{c429:2,usage:3,constructors:1});
  db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  assert.equal(db.pragma('foreign_keys',{simple:true}),foreignKeys);
  db.exec(`INSERT INTO users(id,api_key_hash,name,email,tier) VALUES ('u','synthetic-hash','synthetic','synthetic@example.invalid','free');
  INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','synthetic','openai','api_key','synthetic-only','active','2020-01-01');
  INSERT INTO ordinary_account_attempts VALUES ('a','ordinary-open'); INSERT INTO siwc_account_attempts VALUES ('s','siwc-open');
  INSERT INTO account_429_cooldowns VALUES ('upstream','a',1,2,1),('siwc','s',3,4,2),('upstream','orphan',5,6,3);`);
  const insert=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,error,latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('zero','u','a','2020-01-01 00:00:00','synthetic','openai',0,0,1,null,11);
  insert.run('large','u','a','2020-01-02 00:00:00','synthetic','openai',9007199254740993n,42n,0,'synthetic-error',12);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  return db;
}
function snapshot(db) {
  const objects=db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const tables=objects.filter(o=>o.type==='table').map(o=>o.name);
  const q=s=>'"'+s.replaceAll('"','""')+'"';
  const metadata={}, rows={};
  for (const t of tables) {
    const indexes=db.prepare(`PRAGMA main.index_list(${q(t)})`).all();
    metadata[t]={fk:db.prepare(`PRAGMA main.foreign_key_list(${q(t)})`).all(), indexes, indexDetails:Object.fromEntries(indexes.map(i=>[i.name,db.prepare(`PRAGMA main.index_xinfo(${q(i.name)})`).all()]))};
    rows[t]=db.prepare(`SELECT rowid,* FROM main.${q(t)} ORDER BY rowid`).safeIntegers().all();
  }
  return {objects,metadata,rows,journal:db.pragma('journal_mode',{simple:true})};
}
function harness(db, inject='none') {
  const stat=(ino,file)=>({dev:1n,ino:BigInt(ino),nlink:1n,isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false});
  const entries={'/':stat(1,false),'/safe':stat(2,false),[target]:stat(3,true)};
  const fs={constants:{O_RDONLY:0,O_NOFOLLOW:16},lstatSync(p){assert.ok(Object.hasOwn(entries,p));return entries[p];},openSync(p){assert.equal(p,target);return 9;},fstatSync(fd){assert.equal(fd,9);return entries[target];},closeSync(fd){assert.equal(fd,9);}};
  let open=true, observed=false;
  const fault=new Error('injected after one usage copy');
  const proxy=new Proxy(db,{get(obj,key){
    if(key==='open') return open;
    if(key==='close') return ()=>{open=false;};
    if(key==='exec' && inject!=='none') return sql=>{
      if(sql.startsWith('INSERT INTO main.usage_logs (rowid,')) {
        assert.equal(obj.inTransaction,true);
        assert.equal(obj.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n,3);
        obj.exec(sql+' WHERE rowid=(SELECT min(rowid) FROM main.offline_usage_legacy)');
        observed=obj.prepare('SELECT count(*) n FROM main.usage_logs').get().n===1;
        if (inject==='sql') return obj.exec('SELECT nonexistent_fixture_function()');
        throw fault;
      }
      return obj.exec(sql);
    };
    const v=obj[key];return typeof v==='function'?v.bind(obj):v;
  }});
  return {deps:{fs,path:path.posix,platform:'linux',openDatabase(p,opts){assert.equal(p,target);assert.deepEqual(opts,{fileMustExist:true,timeout:1000});return proxy;}},fault,observed:()=>observed,closed:()=>!open};
}
let completed=0;
for (const foreignKeys of [0,1]) {
test(`real application initialization survives offline cutover (foreign_keys=${foreignKeys})`,()=>{
  const db=fixture(foreignKeys); try {
    const before=snapshot(db), h=harness(db);
    runOffline429([...flags,target],h.deps);
    assert.equal(db.pragma('foreign_keys',{simple:true}),foreignKeys);
    assert.equal(h.closed(),true); assert.equal(db.open,true);
    const after=snapshot(db);
    assert.equal(after.journal,before.journal); assert.equal(before.journal,'memory');
    const added=after.objects.filter(o=>o.tbl_name.startsWith('account_429_v2_')).map(o=>o.name).sort();
    assert.deepEqual(added,['account_429_v2_counter','account_429_v2_restrictions','account_429_v2_schema_marker','sqlite_autoindex_account_429_v2_restrictions_1'].sort());
    assert.equal(after.objects.find(o=>o.type==='table' && o.name==='usage_logs').sql,current.replace('CREATE TABLE IF NOT EXISTS','CREATE TABLE').slice(0,-1));
    assert.deepEqual(after.objects.filter(o=>o.tbl_name==='usage_logs' && o.type==='index'),before.objects.filter(o=>o.tbl_name==='usage_logs' && o.type==='index'));
    schema.assertTokenUsageSchema(db);
    assert.deepEqual(after.objects.filter(o=>o.tbl_name!=='usage_logs' && !o.tbl_name.startsWith('account_429_v2_')),before.objects.filter(o=>o.tbl_name!=='usage_logs'));
    for(const t of Object.keys(before.rows)) if(t!=='usage_logs') {assert.deepEqual(after.rows[t],before.rows[t]);assert.deepEqual(after.metadata[t],before.metadata[t]);}
    assert.deepEqual(after.metadata.usage_logs,before.metadata.usage_logs);
    assert.deepEqual(after.rows.usage_logs.map(({usage_known,...r})=>{assert.equal(usage_known,null);return r;}),before.rows.usage_logs);
    assert.equal(v2.assert429V2Schema(db),3n);
    assert.deepEqual(db.prepare('SELECT kind,account_id,duration_ms FROM account_429_v2_restrictions ORDER BY kind,account_id').all(),db.prepare('SELECT kind,account_id,NULL duration_ms FROM account_429_cooldowns ORDER BY kind,account_id').all());
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    const fresh=client(db,false); assert.equal(fresh.api.initDatabase(),db); assert.deepEqual(fresh.counts(),{constructors:1,c429:2,usage:3});
    assert.deepEqual(snapshot(db),after);
    for(const name of ['users','upstream_accounts','usage_logs','siwc_credentials','ordinary_account_attempts','siwc_account_attempts']) assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    assert.throws(()=>db.prepare("DELETE FROM users WHERE id='u'").run(),/user has usage history/);
    assert.throws(()=>db.prepare("DELETE FROM upstream_accounts WHERE id='a'").run(),/account has usage history/);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    completed++;
  } finally {db.close();}
});
for (const failure of ['js','sql']) test(`${failure} failure after v2 and copied usage rolls back (foreign_keys=${foreignKeys})`,()=>{
  const db=fixture(foreignKeys);try {
    const before=snapshot(db), h=harness(db,failure);
    assert.throws(()=>runOffline429([...flags,target],h.deps),e=>failure==='js' ? e===h.fault : e.code==='SQLITE_ERROR' && e.message==='no such function: nonexistent_fixture_function');
    assert.equal(h.observed(),true);assert.equal(h.closed(),true);assert.equal(db.inTransaction,false);
    assert.deepEqual(snapshot(db),before);assert.equal(db.pragma('foreign_keys',{simple:true}),foreignKeys);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'account_429_v2_%'").get().n,0);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);completed++;
  } finally {db.close();}
});
}
for (const failure of [false,true]) test(`file-backed offline cutover ${failure ? 'rolls back' : 'commits'} and survives reopening`,async()=>{
  // A caller-provided trusted scratch root is required; no system temp fallback.
  const root=process.env.FIXTURE_ROOT;
  assert.ok(typeof root==='string' && path.isAbsolute(root),'absolute fixture root required');
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(root),'shareai-offline-file-'));
  const file=path.join(directory,'fixture.sqlite');
  const handles=[]; let retained=false, observed=false, injected=0;
  function open(options={fileMustExist:true}) {const db=new Database(file,options);handles.push(db);return db;}
  function close(db) {if(db.open) db.close(); if(db.open) throw new Error('fixture database close uncertain');}
  try {
    // Seed via the existing application-schema fixture, then use SQLite's own
    // consistent backup to create a separate test-owned disk database.
    const source=fixture(1);handles.push(source);
    await source.backup(file);close(source);
    let db=open();db.pragma('journal_mode = WAL');const before=snapshot(db);close(db);
    let migrationHandle;
    const adapters={fs,path,platform:process.platform,openDatabase(p,options){
      assert.equal(p,file);assert.deepEqual(options,{fileMustExist:true,timeout:1000});
      const actual=open(options); migrationHandle=actual;
      if(!failure)return actual;
      return new Proxy(actual,{get(obj,key){
        if(key==='exec') return sql=>{
          if(sql.startsWith('INSERT INTO main.usage_logs (rowid,')) {
            injected++;
            assert.equal(obj.inTransaction,true);
            assert.equal(obj.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n,3);
            obj.exec(sql+' WHERE rowid=(SELECT min(rowid) FROM main.offline_usage_legacy)');
            observed=obj.prepare('SELECT count(*) n FROM main.usage_logs').get().n===1;
            return obj.exec('SELECT nonexistent_fixture_function()');
          }
          return obj.exec(sql);
        };
        const value=obj[key];return typeof value==='function'?value.bind(obj):value;
      }});
    }};
    if(failure) {
      assert.throws(()=>runOffline429([...flags,file],adapters),e=>e.code==='SQLITE_ERROR' && e.message==='no such function: nonexistent_fixture_function');
      assert.equal(observed,true);assert.equal(injected,1);
    } else {
      // This is offline CLI-helper contention, not the separate startup-race fixture.
      const blocker=open({fileMustExist:true,timeout:0});blocker.exec('BEGIN IMMEDIATE');
      try {
        assert.throws(()=>runOffline429([...flags,file],adapters),e=>e.code==='SQLITE_BUSY');
        assert.deepEqual(snapshot(blocker),before);
      } finally {blocker.exec('ROLLBACK');close(blocker);}
      runOffline429([...flags,file],adapters);
    }
    assert.ok(migrationHandle);assert.equal(migrationHandle.open,false);
    db=open();const after=snapshot(db);
    assert.equal(after.journal,before.journal);assert.equal(after.journal,'wal');
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    if(failure) {
      assert.deepEqual(after,before);
      assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'account_429_v2_%'").get().n,0);
    } else {
      assert.equal(v2.assert429V2Schema(db),3n);schema.assertTokenUsageSchema(db);
      assert.equal(after.objects.find(o=>o.type==='table' && o.name==='usage_logs').sql,current.replace('CREATE TABLE IF NOT EXISTS','CREATE TABLE').slice(0,-1));
      assert.deepEqual(after.objects.filter(o=>o.tbl_name==='usage_logs' && o.type==='index'),before.objects.filter(o=>o.tbl_name==='usage_logs' && o.type==='index'));
      assert.deepEqual(after.objects.filter(o=>o.tbl_name!=='usage_logs' && !o.tbl_name.startsWith('account_429_v2_')),before.objects.filter(o=>o.tbl_name!=='usage_logs'));
      assert.deepEqual(after.metadata.usage_logs,before.metadata.usage_logs);
      assert.deepEqual(after.rows.usage_logs.map(({usage_known,...row})=>{assert.equal(usage_known,null);return row;}),before.rows.usage_logs);
      assert.equal(after.rows.usage_logs.find(r=>r.id==='large').input_tokens,9007199254740993n);
      for(const t of Object.keys(before.rows)) if(t!=='usage_logs') {assert.deepEqual(after.rows[t],before.rows[t]);assert.deepEqual(after.metadata[t],before.metadata[t]);}
      assert.deepEqual(db.prepare('SELECT kind,account_id,duration_ms FROM account_429_v2_restrictions ORDER BY kind,account_id').all(),db.prepare('SELECT kind,account_id,NULL duration_ms FROM account_429_cooldowns ORDER BY kind,account_id').all());
    }
    if(!failure) {
      const startup=client(db,false,file);
      assert.equal(startup.api.initDatabase(),db);
      assert.deepEqual(startup.counts(),{constructors:1,c429:2,usage:3});
      assert.deepEqual(snapshot(db),after);
      startup.api.closeDatabase();assert.equal(db.open,false);
    } else close(db);
    // A second open checks the state after both the migration and observer handles close.
    db=open();assert.deepEqual(snapshot(db),after);close(db);
    completed++;
  } finally {
    for(const db of handles) {try {close(db);} catch {retained=true;}}
    if(!retained) fs.rmSync(directory,{recursive:true});
    assert.equal(retained,false,'fixture database close uncertain; directory retained');
  }
});
test('offline cutover rejects a hard-linked file without changing either name',async()=>{
  const root=process.env.FIXTURE_ROOT;
  assert.ok(typeof root==='string' && path.isAbsolute(root),'absolute fixture root required');
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(root),'shareai-hardlink-'));
  const file=path.join(directory,'fixture.sqlite'),alias=path.join(directory,'fixture-alias.sqlite');
  const handles=[];let retained=false;
  function track(db){handles.push(db);return db;}
  function close(db){if(db.open)db.close();if(db.open)throw new Error('fixture database close uncertain');}
  try {
    const source=track(fixture(1));await source.backup(file);close(source);
    let db=track(new Database(file,{fileMustExist:true}));const before=snapshot(db);close(db);
    fs.linkSync(file,alias);
    assert.equal(fs.statSync(file,{bigint:true}).nlink,2n);
    const adapters={fs,path,platform:process.platform,openDatabase(p,options){assert.equal(p,file);return track(new Database(p,options));}};
    assert.throws(()=>runOffline429([...flags,file],adapters),/Unsafe database path/);
    db=track(new Database(file,{fileMustExist:true,readonly:true}));assert.deepEqual(snapshot(db),before);close(db);
    db=track(new Database(alias,{fileMustExist:true,readonly:true}));assert.deepEqual(snapshot(db),before);close(db);
    completed++;
  } finally {
    for(const db of handles){try{close(db);}catch{retained=true;}}
    if(!retained)fs.rmSync(directory,{recursive:true});
    assert.equal(retained,false,'fixture database close uncertain; directory retained');
  }
});
test('new hard link during cutover prevents commit and rolls back',async()=>{
  const root=process.env.FIXTURE_ROOT;
  assert.ok(typeof root==='string' && path.isAbsolute(root),'absolute fixture root required');
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(root),'shareai-link-race-'));
  const file=path.join(directory,'fixture.sqlite'),alias=path.join(directory,'fixture-alias.sqlite');
  const handles=[];let retained=false,linkedDuringTransaction=false;
  function track(db){handles.push(db);return db;}
  function close(db){if(db.open)db.close();if(db.open)throw new Error('fixture database close uncertain');}
  try {
    const source=track(fixture(1));await source.backup(file);close(source);
    let db=track(new Database(file,{fileMustExist:true}));const before=snapshot(db);close(db);
    const adapters={fs,path,platform:process.platform,openDatabase(p,options){assert.equal(p,file);const actual=track(new Database(p,options));return new Proxy(actual,{get(obj,key){
      if(key==='exec')return sql=>{const result=obj.exec(sql);if(sql.startsWith('INSERT INTO main.usage_logs (rowid,')){
        assert.equal(obj.inTransaction,true);assert.equal(obj.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n,3);
        fs.linkSync(file,alias);linkedDuringTransaction=fs.statSync(file,{bigint:true}).nlink===2n;
      }return result;};
      const value=obj[key];return typeof value==='function'?value.bind(obj):value;
    }});}};
    assert.throws(()=>runOffline429([...flags,file],adapters),/Database path changed/);
    assert.equal(linkedDuringTransaction,true);
    for(const name of [file,alias]){db=track(new Database(name,{fileMustExist:true,readonly:true}));assert.deepEqual(snapshot(db),before);close(db);}
    completed++;
  } finally {
    for(const db of handles){try{close(db);}catch{retained=true;}}
    if(!retained)fs.rmSync(directory,{recursive:true});
    assert.equal(retained,false,'fixture database close uncertain; directory retained');
  }
});
test.after(()=>{assert.equal(completed,10);console.log('OFFLINE_APP_SCHEMA_SUCCESS:10');});
}
