// In-process VM coordination test. Timers and writer are simulated; no sockets,
// real writer contention, process isolation, or global producer drain is proven.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const express = require('express');
const Database = require('better-sqlite3');
const root = new URL('../src/', import.meta.url);
const source = name => ts.transpileModule(readFileSync(new URL(name, root), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true}}).outputText;
const sources = Object.fromEntries(['server.ts','db/client.ts','db/account-429-v2-store.ts','db/account-429-v2-expiry.ts'].map(n => [n, source(n)]));
function instrumentDeadline(code) {
  const call='shutdownDeadline = setTimeout(';
  assert.equal(code.split(call).length,2,'shutdown deadline call must occur once');
  return code.replace(call,'shutdownDeadline = __deadlineTimer(');
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise, resolve, reject}; }
async function bounded(promise,label) { let timer; try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),2000);})]);} finally {clearTimeout(timer);} }
function fixture(schema = true, bindFails = false) {
  const db = new Database(':memory:');
  const timers = new Map(), signals = {}, events = [], errors = [];
  let nextTimer = 0, now = 0, listens = 0, closed = false, writer = null, expiryDrain, schemaFailure;
  const writerSettled=deferred();
  const proc = {env:{}, exitCode:0, hrtime:{bigint:()=>0n}, on:(s,f)=>{signals[s]=f;}, exit:c=>events.push('exit:'+c)};
  const setTimer = (fn, delay) => { const id={id:++nextTimer,unref(){}}; timers.set(id,{fn,delay,due:now+delay}); return id; };
  const deadlineTimer = (fn,delay) => {assert.equal(delay,5000);const id=setTimer(fn,delay);id.unref=()=>events.push('deadline-unref');return id;};
  const clearTimer = id => { events.push('clear:'+timers.get(id)?.delay); timers.delete(id); };
  let listener;
  const appFactory = () => { const app=express(); app.listen=(_p,_h,cb)=>{ listens++; const server=new EventEmitter(); server.close=cb=>cb?.(); server.closeAllConnections=()=>{}; listener=server; if(!bindFails) queueMicrotask(()=>{events.push('listening');cb();}); return server; }; return app; };
  appFactory.json=express.json;
  const client={initDatabase:()=>db, requireInitializedDatabase:()=>{events.push('schema-check');return db;}, closeDatabase:()=>{events.push('db-close'); closed=true; db.close();}};
  const mocks={
    express:{default:appFactory,__esModule:true}, './http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js':{env:{PORT:1,HOST:'fixture',NODE_ENV:'test'}},
    './utils/logger.js':{logger:{info:()=>{},error:(...args)=>errors.push(args)}},
    './upstream/oauth.js':{stopOAuth:async()=>{}}, './upstream/siwc-login.js':{stopSiwc:async()=>{},noStoreSiwc:(_q,_s,n)=>n()},
    './upstream/tokens.js':{drainTokenRefreshes:()=>{events.push('token-stop'); return Promise.resolve();}},
    './request-work.js':{requestWork:{stopAndDrain:()=>{events.push('request-stop'); return Promise.resolve();}},trackedErrorHandler:f=>f},
    './routes/v1.js':{default:express.Router(),__esModule:true}, './routes/admin.js':{default:express.Router(),__esModule:true},
    './db/client.js':client, './client.js':client, './db/async-writer.js':{retryQuarantinedWriters:()=>{}},
    './async-writer.js':{withAsyncWriter:async fn=>{ events.push('simulated-writer-enter'); try {if(writer) await writer.promise; return await fn(db);} finally {events.push('simulated-writer-settled');writerSettled.resolve();} }}
  };
  const context=vm.createContext({process:proc,setTimeout:setTimer,clearTimeout:clearTimer,__deadlineTimer:deadlineTimer,AbortController,console,queueMicrotask});
  const cache={};
  function load(name) {
    if(cache[name]) return cache[name];
    const module={exports:{}}; cache[name]=module.exports;
    const req=id=> id==='./account-429-v2-store.js'||id==='./db/account-429-v2-store.js' ? load('db/account-429-v2-store.ts') : id==='./db/account-429-v2-expiry.js' ? load('db/account-429-v2-expiry.ts') : (id in mocks ? mocks[id] : (()=>{throw Error('Unexpected dependency '+id);})());
    vm.runInContext('(function(require,module,exports){'+(name==='server.ts'?instrumentDeadline(sources[name]):sources[name])+'\n})',context)(req,module,module.exports);
    if(name==='db/account-429-v2-store.ts') {
      const original=module.exports.assert429V2Schema;
      module.exports.assert429V2Schema=function(...args){try{return original(...args);}catch(error){schemaFailure=error?.message;throw error;}};
    }
    if(name==='db/account-429-v2-expiry.ts') {
      const proto=module.exports.Account429V2Expiry.prototype, original=proto.stopAndDrain;
      proto.stopAndDrain=function(...args){expiryDrain=original.apply(this,args); return expiryDrain;};
    }
    cache[name]=module.exports; return module.exports;
  }
  if(schema) db.transaction(()=>load('db/account-429-v2-store.ts').provision429V2(db)).immediate();
  return {db,events,errors,timers,signals,proc,load,writerSettled:writerSettled.promise, get schemaFailure(){return schemaFailure;},get expiryDrain(){return expiryDrain;},get listener(){return listener;},get listens(){return listens;},get closed(){return closed;},get timerCount(){return nextTimer;}, setWriter(w){writer=w;}, advance(ms){const target=now+ms; while(true){const next=[...timers].filter(([,t])=>t.due<=target).sort((a,b)=>a[1].due-b[1].due)[0]; if(!next) break; now=next[1].due; timers.delete(next[0]); next[1].fn();} now=target;}, fire(delay){const found=[...timers].find(([,v])=>v.delay===delay); assert.ok(found,`missing simulated timer ${delay}`); timers.delete(found[0]); found[1].fn();}, dispose(){if(db.open) db.close();}};
}
const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
test('missing schema fails startup after listener callback', async()=>{const f=fixture(false); try { f.load('server.ts'); await flush(); assert.equal(f.listens,1); assert.ok(f.events.indexOf('listening')>=0 && f.events.indexOf('schema-check')>f.events.indexOf('listening')); assert.match(f.schemaFailure,/^Unsafe 429 v2 schema/); assert.equal(f.proc.exitCode,1); assert.ok(f.errors.some(args=>args[0]==='Server startup failed')); assert.ok(![...f.timers.values()].some(t=>t.delay===1000)); } finally { f.dispose(); }});
test('partial schema fails startup after listener callback', async()=>{const f=fixture(false); try {f.db.exec('CREATE TABLE account_429_v2_schema_marker (id INTEGER)'); f.load('server.ts'); await flush(); assert.equal(f.listens,1); assert.ok(f.events.indexOf('listening')>=0 && f.events.indexOf('schema-check')>f.events.indexOf('listening')); assert.match(f.schemaFailure,/^Unsafe 429 v2 schema/); assert.equal(f.proc.exitCode,1); assert.ok(f.errors.some(args=>args[0]==='Server startup failed')); assert.ok(![...f.timers.values()].some(t=>t.delay===1000));} finally {f.dispose();}});
test('shutdown clears a scheduled simulated timer and retains database', async()=>{const f=fixture(); try {f.load('server.ts'); await flush(); assert.ok([...f.timers.values()].some(t=>t.delay===1000)); f.signals.SIGTERM(); await flush(); assert.ok(f.events.includes('clear:1000')); assert.ok(f.events.includes('deadline-unref')); assert.equal(f.closed,false); assert.equal(f.db.open,true);} finally {f.dispose();}});
test('scheduler shutdown stops admission and waits for simulated writer', async()=>{const f=fixture(); let w; try { f.load('server.ts'); await flush(); assert.equal(f.listens,1); w=deferred(); f.setWriter(w); f.fire(1000); await flush(); assert.ok(f.events.includes('simulated-writer-enter')); f.signals.SIGTERM(); assert.ok(f.events.indexOf('request-stop')>=0 && f.events.indexOf('request-stop')<f.events.indexOf('token-stop')); await flush(); assert.equal(f.closed,false); assert.ok(!f.events.includes('deadline-unref')); w.resolve(); await bounded(f.writerSettled,'simulated writer'); await flush(); assert.equal(f.closed,false); assert.equal(f.db.open,true); assert.ok(f.events.includes('deadline-unref')); assert.ok(f.events.indexOf('simulated-writer-settled')<f.events.indexOf('deadline-unref')); assert.ok(![...f.timers.values()].some(t=>t.delay===1000)); } finally { w?.resolve(); if(f.events.includes('simulated-writer-enter')) await bounded(f.writerSettled,'simulated writer cleanup'); if(!w || f.events.includes('deadline-unref')) f.dispose(); }});
test('simulated automatic writer failure is sanitized and prevents database close', async()=>{const f=fixture(); try {f.load('server.ts'); await flush(); const w=deferred(); f.setWriter(w); f.fire(1000); await flush(); w.reject(Error('synthetic-secret')); await flush(); assert.ok(f.errors.length); assert.ok(!JSON.stringify(f.errors).includes('synthetic-secret')); f.signals.SIGTERM(); await flush(); assert.equal(f.closed,false); assert.equal(f.proc.exitCode,1);} finally {f.dispose();}});
test('simulated shutdown deadline does not close database under a pending writer', async()=>{const f=fixture(); try {f.load('server.ts'); await flush(); const w=deferred(); f.setWriter(w); f.fire(1000); await flush(); f.signals.SIGTERM(); await flush(); f.fire(5000); assert.equal(f.closed,false); assert.equal(f.proc.exitCode,1); assert.ok(f.events.includes('exit:1')); w.resolve(); await flush(); assert.equal(f.closed,false);} finally {f.dispose();}});
test('listener error retains database through pending scheduler drain', async()=>{const f=fixture(); let w; try {f.load('server.ts'); await flush(); w=deferred(); f.setWriter(w); f.fire(1000); await flush(); assert.ok(f.events.includes('simulated-writer-enter')); f.listener.emit('error',Error('synthetic-secret')); await flush(); assert.ok(f.expiryDrain); let drainSettled=false; void f.expiryDrain.then(()=>{drainSettled=true;},()=>{drainSettled=true;}); await flush(); assert.equal(drainSettled,false); assert.equal(f.proc.exitCode,1); assert.equal(f.closed,false); assert.ok(!JSON.stringify(f.errors).includes('synthetic-secret')); w.resolve(); await bounded(f.writerSettled,'simulated writer'); await bounded(f.expiryDrain,'scheduler drain'); assert.equal(drainSettled,true); assert.equal(f.closed,false); assert.ok(![...f.timers.values()].some(t=>t.delay===1000));} finally {w?.resolve(); if(f.events.includes('simulated-writer-enter')) await bounded(f.writerSettled,'simulated writer cleanup'); if(f.expiryDrain) await bounded(f.expiryDrain,'scheduler drain cleanup'); if(!f.events.includes('simulated-writer-enter') || f.expiryDrain) f.dispose();}});

function clientFixture(corrupt=false, valid=false, invalidateBeforeWriter=false) {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
    CREATE TABLE ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO ordinary_attempts_schema_marker VALUES (1,1);
    CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
    CREATE TABLE siwc_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO siwc_attempts_schema_marker VALUES (1,1);
    CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged');`);
  if(corrupt) db.exec('CREATE TABLE account_429_v2_schema_marker (id INTEGER)');
  const changes=[], usageSchemaCalls=[]; let options;
  const originalPragma=db.pragma.bind(db); db.pragma=(sql,...args)=>{changes.push(sql); return originalPragma(sql,...args);};
  const handle={open:true,close(){this.open=false;},prepare:db.prepare.bind(db),exec:db.exec.bind(db),pragma:db.pragma.bind(db),transaction(fn){const tx=db.transaction(fn); return {immediate(){if(invalidateBeforeWriter) db.exec('DELETE FROM account_429_v2_schema_marker'); return tx.immediate();}};},get inTransaction(){return db.inTransaction;}};
  const mocks={'better-sqlite3':{default:class {constructor(_path,opts){options=opts; return handle;}},__esModule:true},
    '../config/env.js':{env:{DATABASE_URL:'sqlite:fixture'}}, '../utils/logger.js':{logger:{info(){},error(){}}},
    // This fixture isolates v2 preflight; it does not validate the real usage schema.
    './schema.js':{assertTokenUsageSchema: function isolatedUsageSchemaStub(candidate, allowMissing) {
      assert.equal(candidate,handle);
      const startupExists=db.prepare("SELECT 1 FROM sqlite_schema WHERE name='startup_write'").get();
      usageSchemaCalls.push({allowMissing,inTransaction:db.inTransaction,startupRows:startupExists ? db.prepare('SELECT count(*) AS n FROM startup_write').get().n : null});
    }, SQL_SCHEMA:`CREATE TABLE startup_write (id INTEGER); INSERT INTO startup_write VALUES (1);
      CREATE TABLE upstream_accounts (id TEXT PRIMARY KEY, credentials TEXT, credential_type TEXT CHECK(credential_type IN ('oauth')), status TEXT, last_error TEXT, meta TEXT, quota_info TEXT, state_revision INTEGER, request_revision INTEGER, credential_revision INTEGER, last_refresh_revision INTEGER);
      CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE usage_logs (user_id TEXT, upstream_account_id TEXT, success INTEGER, timestamp TEXT); CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY);`}, '../upstream/siwc-store.js':{SiwcStore:{initialize(){}}},
    path:{default:{dirname:()=>'.'},__esModule:true},fs:{default:{existsSync:()=>true,mkdirSync:()=>{throw Error('unexpected mkdir');}},__esModule:true}};
  const context=vm.createContext({process:{env:{}},console}); const cache={};
  function load(name){if(cache[name]) return cache[name]; const module={exports:{}}; const req=id=>id==='./account-429-v2-store.js'?load('db/account-429-v2-store.ts'):id in mocks?mocks[id]:(()=>{throw Error('unexpected dependency '+id)})(); vm.runInContext('(function(require,module,exports){'+sources[name]+'\n})',context)(req,module,module.exports); return cache[name]=module.exports;}
  if(valid) db.transaction(()=>load('db/account-429-v2-store.ts').provision429V2(db)).immediate();
  return {db,changes,usageSchemaCalls,load,get options(){return options;},dispose(){db.close();}};
}
for(const corrupt of [false,true]) test(`actual client rejects ${corrupt?'corrupt':'missing'} v2 before mutation`,()=>{const f=clientFixture(corrupt); try {const before=f.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(); const journal=f.db.pragma('journal_mode',{simple:true}); f.changes.length=0; assert.throws(()=>f.load('db/client.ts').initDatabase(),/429 v2/); assert.deepEqual(f.usageSchemaCalls,[]); assert.deepEqual(f.changes,[]); assert.equal(f.db.pragma('journal_mode',{simple:true}),journal); assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all(),before); assert.equal(f.db.prepare('SELECT value FROM sentinel').get().value,'unchanged'); assert.equal(f.options.fileMustExist,true);} finally {f.dispose();}});
test('actual client initializes a pre-provisioned v2 fixture',()=>{const f=clientFixture(false,true); try {const client=f.load('db/client.ts'); client.initDatabase(); assert.deepEqual(f.usageSchemaCalls,[{allowMissing:true,inTransaction:false,startupRows:null},{allowMissing:true,inTransaction:true,startupRows:null},{allowMissing:undefined,inTransaction:true,startupRows:1}]); assert.deepEqual(f.db.prepare('SELECT id FROM startup_write').all(),[{id:1}]); assert.equal(f.options.fileMustExist,true); client.closeDatabase();} finally {f.dispose();}});
test('actual client rechecks v2 inside writer after simulated invalidation',()=>{const f=clientFixture(false,true,true); try {assert.throws(()=>f.load('db/client.ts').initDatabase(),{message:'Unsafe 429 v2 schema marker'}); assert.deepEqual(f.usageSchemaCalls,[{allowMissing:true,inTransaction:false,startupRows:null}]); assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='startup_write'").get().n,0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM account_429_v2_schema_marker').get().n,0);} finally {f.dispose();}});
test('fatal listener error preserves an already-running shutdown deadline',async()=>{
  const f=fixture();
  try {
    f.load('server.ts'); await flush();
    const w=deferred(); f.setWriter(w); f.fire(1000); await flush();
    f.signals.SIGTERM(); await flush();
    const count=f.timerCount;
    f.advance(4999);
    f.listener.emit('error',Error('synthetic'));
    f.listener.emit('error',Error('reentrant')); f.signals.SIGINT();
    w.resolve(); await flush();
    assert.equal(f.closed,false);
    assert.equal(f.events.filter(e=>e==='exit:1').length,0);
    f.advance(1);
    assert.equal(f.events.filter(e=>e==='exit:1').length,1);
    assert.equal(f.proc.exitCode,1);
    assert.equal(f.timerCount,count);
    assert.equal(f.events.filter(e=>e==='request-stop').length,1);
    assert.equal(f.events.filter(e=>e==='token-stop').length,1);
    assert.equal(f.closed,false);
    f.advance(5000); await flush();
    assert.equal(f.events.filter(e=>e==='exit:1').length,1);
    assert.equal(f.closed,false);
  } finally { f.dispose(); }
});

test('listener error after listening retains database',async()=>{const f=fixture(); try {f.load('server.ts'); await flush(); f.listener.emit('error',Error('synthetic-secret')); await flush(); assert.equal(f.proc.exitCode,1); assert.equal(f.closed,false); assert.ok(![...f.timers.values()].some(t=>t.delay===1000)); assert.ok(!JSON.stringify(f.errors).includes('synthetic-secret'));} finally {f.dispose();}});

// Fully synthetic fatal-path fixture: no database, listener, network, or real timers.
function fatalFixture(listen = true, failures = false) {
  const events=[], timers=new Map(), signals={}, scheduler=deferred(), request=deferred();
  const server=new EventEmitter(); let listening;
  server.close=()=>{events.push('server-close'); if(failures) return Promise.reject(Error('close'));};
  server.closeAllConnections=()=>events.push('close-connections');
  const appFactory=()=>{const app=express(); app.listen=(_p,_h,cb)=>{listening=cb; return server;}; return app;};
  appFactory.json=express.json;
  const proc={env:{},exitCode:0,hrtime:{bigint:()=>0n},on:(s,f)=>{signals[s]=f;},exit:c=>events.push('exit:'+c)};
  const mocks={
    express:{default:appFactory,__esModule:true}, './http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js':{env:{PORT:1,HOST:'fixture',NODE_ENV:'test'}},
    './utils/logger.js':{logger:{info:()=>events.push('log'),error:()=>events.push('log')}},
    './upstream/oauth.js':{stopOAuth:()=>{events.push('oauth-stop'); if(failures) throw Error('oauth'); return Promise.resolve();}},
    './upstream/siwc-login.js':{stopSiwc:()=>{events.push('siwc-stop'); return failures ? Promise.reject(Error('siwc')) : Promise.resolve();},noStoreSiwc:(_q,_s,n)=>n()},
    './upstream/tokens.js':{drainTokenRefreshes:()=>{events.push('token-stop'); return failures ? Promise.reject(Error('token')) : Promise.resolve();}},
    './request-work.js':{requestWork:{stopAndDrain:()=>{events.push('request-stop'); if(failures) throw Error('request'); return request.promise;}},trackedErrorHandler:f=>f},
    './routes/v1.js':{default:express.Router(),__esModule:true}, './routes/admin.js':{default:express.Router(),__esModule:true},
    './db/client.js':{initDatabase(){},requireInitializedDatabase(){return {};},closeDatabase(){events.push('db-close');}},
    './db/async-writer.js':{retryQuarantinedWriters(){}}, './db/account-429-v2-store.js':{assert429V2Schema(){}},
    './db/account-429-v2-expiry.js':{Account429V2Expiry:class {start(){} stopAndDrain(){events.push('expiry-stop'); return failures ? Promise.reject(Error('expiry')) : scheduler.promise;}}}
  };
  const context=vm.createContext({process:proc,console,setTimeout:(fn,delay)=>{events.push('timer:'+delay); const h={unref(){events.push('unref');}}; timers.set(h,{fn,delay}); return h;},clearTimeout:h=>{events.push('clear'); timers.delete(h);}});
  const module={exports:{}};
  vm.runInContext('(function(require,module,exports){'+sources['server.ts']+'\n})',context)(id=>{if(!(id in mocks)) throw Error('Unexpected dependency '+id); return mocks[id];},module,module.exports);
  if(listen) listening();
  events.length=0;
  return {events,timers,signals,server,proc,scheduler,request};
}
for (const listen of [true,false]) test(`fatal ${listen?'post-listen':'pre-listen'} error is bounded with stalled producers`,async()=>{
  const f=fatalFixture(listen);
  f.server.emit('error',Error('synthetic'));
  const expected=['timer:5000','request-stop','token-stop',...(listen?['expiry-stop']:[]),'oauth-stop','siwc-stop','server-close'];
  assert.deepEqual(f.events.slice(0,expected.length),expected);
  if (!listen) assert.equal(f.events.includes('expiry-stop'),false);
  assert.equal(f.proc.exitCode,1);
  assert.equal(f.timers.size,1);
  const [handle,timer]=[...f.timers][0];
  assert.equal(timer.delay,5000);
  assert.ok(!f.events.includes('unref'));
  const before=[...f.events];
  f.server.emit('error',Error('again')); f.signals.SIGTERM(); f.signals.SIGINT();
  assert.deepEqual(f.events,before);
  assert.equal(f.timers.has(handle),true);
  assert.ok(!f.events.includes('db-close'));
  f.timers.delete(handle); timer.fn();
  timer.fn();
  assert.equal(f.events.filter(e=>e==='exit:1').length,1);
  f.scheduler.resolve(); f.request.resolve(); await flush();
  assert.ok(!f.events.includes('db-close'));
});
test('fatal post-listen error stops OAuth and SIWC before returning, without waiting for other drains',async()=>{
  const f=fatalFixture(true);
  f.server.emit('error',Error('synthetic'));
  assert.equal(f.events.filter(e=>e==='oauth-stop').length,1);
  assert.equal(f.events.filter(e=>e==='siwc-stop').length,1);
  assert.equal(f.events.filter(e=>e==='timer:5000').length,1);
  assert.ok(f.events.indexOf('timer:5000')<f.events.indexOf('oauth-stop'));
  assert.ok(f.events.indexOf('timer:5000')<f.events.indexOf('siwc-stop'));
  assert.ok(!f.events.includes('db-close'));
  f.server.emit('error',Error('reentrant'));
  assert.equal(f.events.filter(e=>e==='oauth-stop').length,1);
  assert.equal(f.events.filter(e=>e==='siwc-stop').length,1);
  f.scheduler.resolve(); f.request.resolve(); await flush();
});
test('fatal stop hook failures do not skip other stop hooks or the deadline',async()=>{
  const f=fatalFixture(true,true);
  f.server.emit('error',Error('synthetic'));
  await flush();
  for(const name of ['request-stop','token-stop','oauth-stop','siwc-stop','expiry-stop','server-close'])
    assert.equal(f.events.filter(e=>e===name).length,1,`${name} must be attempted`);
  assert.equal(f.timers.size,1);
  assert.ok(!f.events.includes('unref')&&!f.events.includes('db-close'));
  const [[,timer]]=[...f.timers];timer.fn();
  assert.equal(f.events.filter(e=>e==='exit:1').length,1);
});
test('fatal stops tolerate throws and rejections without skipping barriers or deadline',async()=>{
  const f=fatalFixture(true,true);
  f.server.emit('error',Error('synthetic'));
  await flush();
  assert.deepEqual(f.events.slice(0,4),['timer:5000','request-stop','token-stop','expiry-stop']);
  assert.ok(f.events.includes('server-close'));
  assert.equal(f.timers.size,1);
  assert.ok(!f.events.includes('db-close'));
  const [[,timer]]=[...f.timers]; timer.fn();
  assert.equal(f.events.filter(e=>e==='exit:1').length,1);
});

// Synthetic explicitly registered work only: no HTTP response or claim that
// every production producer has been registered with RequestWorkManager.
test('real request-work drain protects explicitly registered synthetic work during server shutdown', {timeout: 5000}, async()=>{
  const requestSource=source('request-work.ts');
  const bounded=async(promise,label)=>{
    let timer;
    try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),1000);})]); }
    finally { clearTimeout(timer); }
  };
  async function scenario(bypass) {
    const db=new Database(':memory:');
    const events=[], signals={}, entered=deferred(), release=deferred(), completed=deferred(), listenerClosed=deferred();
    const hooks=Object.fromEntries(['token','expiry','oauth','siwc'].map(name=>[name,deferred()]));
    let handler, actualDrain, snapshot, primary, hasPrimary=false;
    try {
      db.exec('CREATE TABLE synthetic_work (value TEXT NOT NULL)');
      const proc={env:{},exitCode:0,hrtime:{bigint:()=>0n},on:(s,f)=>{signals[s]=f;},exit:()=>{throw Error('unexpected exit');}};
      const appFactory=()=>{const app=express(); app.listen=(_p,_h,cb)=>{const listener=new EventEmitter(); listener.close=done=>{events.push('listener-close'); done(); listenerClosed.resolve();}; listener.closeAllConnections=()=>{}; queueMicrotask(cb); return listener;}; return app;};
      appFactory.json=express.json;
      const hook=name=>()=>Promise.resolve().then(()=>{events.push(name+'-done'); hooks[name].resolve();});
      const context=vm.createContext({process:proc,console,queueMicrotask,AbortController,__deadlineTimer:(_fn,delay)=>{assert.equal(delay,5000);return {unref(){events.push('deadline-unref');completed.resolve();}};},setTimeout:()=>{throw Error('unexpected timer');},clearTimeout:()=>{}});
      const requestModule={exports:{}};
      vm.runInContext('(function(require,module,exports){'+requestSource+'\n})',context)(id=>{
        if(id==='node:async_hooks') return require('node:async_hooks');
        throw Error('Unexpected request-work dependency '+id);
      },requestModule,requestModule.exports);
      const manager=new requestModule.exports.RequestWorkManager();
      const stop=manager.stopAndDrain.bind(manager);
      manager.stopAndDrain=()=>{
        events.push('request-stop');
        actualDrain=stop();
        actualDrain.then(()=>events.push('request-drained'));
        // Negative control: discard the real drain promise at the server seam.
        return bypass ? Promise.resolve() : actualDrain;
      };
      const mocks={
        express:{default:appFactory,__esModule:true}, './http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js':{env:{PORT:1,HOST:'fixture',NODE_ENV:'test'}},
        './utils/logger.js':{logger:{info(){},error(){}}},
        './upstream/oauth.js':{stopOAuth:hook('oauth')}, './upstream/siwc-login.js':{stopSiwc:hook('siwc'),noStoreSiwc:(_q,_s,n)=>n()},
        './upstream/tokens.js':{drainTokenRefreshes:hook('token')},
        './request-work.js':{requestWork:manager,trackedErrorHandler:requestModule.exports.trackedErrorHandler},
        './routes/v1.js':{default:express.Router(),__esModule:true}, './routes/admin.js':{default:express.Router(),__esModule:true},
        './db/client.js':{initDatabase(){},requireInitializedDatabase(){return db;},closeDatabase(){events.push('db-close'); db.close();}},
        './db/async-writer.js':{retryQuarantinedWriters(){}}, './db/account-429-v2-store.js':{assert429V2Schema(){}},
        './db/account-429-v2-expiry.js':{Account429V2Expiry:class {start(){} stopAndDrain(){return hook('expiry')();}}}
      };
      const serverModule={exports:{}};
      vm.runInContext('(function(require,module,exports){'+instrumentDeadline(sources['server.ts'])+'\n})',context)(id=>{
        if(!(id in mocks)) throw Error('Unexpected server dependency '+id);
        return mocks[id];
      },serverModule,serverModule.exports);
      assert.equal(manager.ownedDispatch(scope=>{
        handler=scope.run(async()=>{events.push('handler-enter'); entered.resolve(); await release.promise; db.prepare('INSERT INTO synthetic_work VALUES (?)').run('completed'); events.push('insert');}).finally(()=>scope.terminal());
      }),true);
      // Attach immediately even if the negative control closes the database first.
      handler.catch(()=>{});
      await bounded(entered.promise,'handler entered');
      signals.SIGTERM();
      await bounded(Promise.all([listenerClosed.promise,...Object.values(hooks).map(h=>h.promise)]),'listener and non-request drains');
      assert.ok(actualDrain,'real stopAndDrain was not called');
      let dispatched=false;
      assert.equal(manager.ownedDispatch(()=>{dispatched=true;}),false);
      assert.equal(dispatched,false);
      if(bypass) {
        await bounded(completed.promise,'negative control shutdown marker');
        assert.equal(db.open,true);
        assert.ok(events.includes('deadline-unref') && !events.includes('insert'));
        events.push('release'); release.resolve();
        await bounded(Promise.all([handler,actualDrain]),'negative control work and real drain');
        assert.deepEqual(db.prepare('SELECT value FROM synthetic_work').all(),[{value:'completed'}]);
        assert.ok(events.indexOf('deadline-unref')<events.indexOf('release'));
        throw Error('drain-bypassed-before-owned-work');
      }
      if(!db.open || events.includes('db-close')) throw Error('DB-close-before-owned-work');
      if(events.includes('deadline-unref')) throw Error('drain-bypassed-before-owned-work');
      events.push('release'); release.resolve();
      await bounded(Promise.all([handler,actualDrain,completed.promise]),'work, real drain and shutdown marker');
      snapshot=db.prepare('SELECT value FROM synthetic_work').all();
      assert.deepEqual(snapshot,[{value:'completed'}]);
      assert.equal(db.open,true);
      for(const event of ['handler-enter','request-stop','listener-close','token-done','expiry-done','oauth-done','siwc-done','insert','request-drained']) assert.ok(events.indexOf(event)>=0 && events.indexOf(event)<events.indexOf('deadline-unref'),event+' must precede deadline-unref');
      assert.ok(events.indexOf('insert')<events.indexOf('request-drained'));
      assert.equal(proc.exitCode,0);
    } catch(error) {primary=error;hasPrimary=true;throw error;} finally {
      release.resolve();
      try {
        if(handler) await bounded(Promise.allSettled([handler,...(actualDrain?[actualDrain]:[])]),'handler cleanup');
        if(db.open) db.close();
      } catch(cleanupError) {
        if(hasPrimary) throw new AggregateError([primary,cleanupError],'scenario and cleanup failed');
        throw cleanupError;
      }
    }
  }
  await assert.rejects(scenario(true),{message:'drain-bypassed-before-owned-work'});
  await scenario(false);
});
