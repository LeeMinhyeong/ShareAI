import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { Writable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const child = process.argv[2] === '--child';

// QUARANTINED: neither the parent nor child is approved to run. The existing
// lifecycle assertions do not yet prove database closure or a drained writer,
// and third-party transitive initialization has not been independently audited.
// Keep this outside the default test glob. Removing this stop requires review;
// an empty environment is necessary but is not a filesystem/network sandbox.
if (Object.keys(process.env).length !== 0) {
  throw new Error('fixture requires an explicitly empty process environment');
}
throw new Error('fixture quarantined pending independent safety review and repair');

if (!child) {
  for (const mode of ['normal', 'mutant']) test(`late usage writer shutdown: ${mode}`, { timeout: 15000 }, async () => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, excessive = false, timedOut = false, spawnError = false;
    p.on('error', () => { spawnError = true; });
    p.stdout.on('error', () => { spawnError = true; });
    p.stderr.on('error', () => { spawnError = true; });
    const collect = chunk => {
      bytes += chunk.length;
      if (bytes > 16384) { excessive = true; p.kill(); return; }
      output += chunk.toString();
    };
    p.stdout.on('data', collect); p.stderr.on('data', collect);
    const close = new Promise(resolve => p.once('close', (code, signal) => resolve({code, signal})));
    let stopTimer;
    const deadline = new Promise(resolve => {
      stopTimer = setTimeout(() => { timedOut = true; p.kill(); resolve(null); }, 10000);
    });
    try {
    let result = await Promise.race([close, deadline]);
    clearTimeout(stopTimer);
    if (!result) {
      let reapTimer;
      result = await Promise.race([close, new Promise(resolve => { reapTimer = setTimeout(() => resolve(null), 3000); })]);
      clearTimeout(reapTimer);
    }
    assert.ok(result !== null, 'child close not observed');
    assert.ok(!spawnError && !excessive && !timedOut, 'child launch or bounds failed');
    assert.ok(result.code === 0 && result.signal === null, 'child failed');
    // Never include untrusted child output in an assertion diff.
    assert.ok(output.trim() === `PASS ${mode} 1`, 'child case marker missing');
    } finally {
      clearTimeout(stopTimer);
      if (p.exitCode === null && p.signalCode === null) p.kill();
      let reapTimer;
      const reaped = await Promise.race([close.then(() => true), new Promise(resolve => { reapTimer=setTimeout(() => resolve(false), 3000); })]);
      clearTimeout(reapTimer);
      assert.ok(reaped, 'child close and stream closure not confirmed');
    }
  });
} else {
  // A detached route rejection can arrive after the mutation releases its writer.
  // Do not print rejection values or allow a late failure to become a pass.
  const fatal = () => { console.error('fixture failure'); process.exit(1); };
  process.on('unhandledRejection', fatal);
  process.on('uncaughtException', fatal);
  const watchdog = setTimeout(fatal, 9000);
  // Guard network before loading TypeScript, Express, SQLite, or application code.
  const deny = () => { throw Error('network or listener disabled'); };
  net.connect = net.createConnection = deny; net.Socket.prototype.connect = deny;
  net.Server.prototype.listen = deny; tls.connect = deny;
  http.request = http.get = https.request = https.get = deny;
  http.Server.prototype.listen = https.Server.prototype.listen = deny;
  dgram.createSocket = deny;
  for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'Resolver']) dns[name] = deny;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = deny;
  globalThis.fetch = deny;
  syncBuiltinESMExports();
  const ts = require('typescript'), express = require('express'), Database = require('better-sqlite3');
  const mode = process.argv[3];
  const assertMode = () => assert.ok(mode === 'normal' || mode === 'mutant');
  function load(file, deps, extras = {}, mutate) {
    let text = readFileSync(path.join(root, file), 'utf8');
    if (mutate) {
      const before = 'if (!res.destroyed) await handler(req, res);';
      assert.equal(text.split(before).length, 2, 'mutation target must be unique');
      text = text.replace(before, 'if (!res.destroyed) __fixtureObserveDetached(handler(req, res));');
    }
    const code = ts.transpileModule(text, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const exports = {};
    vm.runInThisContext(`(function(exports,require,process,__fixtureObserveDetached){${code}\n})`)(exports, name => {
      if (!Object.hasOwn(deps, name)) throw Error('unexpected dependency '+name);
      return deps[name];
    }, extras.process ?? process, extras.observeDetached);
    return exports;
  }
  function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return {promise, resolve, reject}; }
  async function run() {
    assertMode();
    const db = new Database(':memory:');
    const events=[], sockets=[], entered=deferred(), release=deferred(), drainEntered=deferred(), dbClosed=deferred();
    // Observe failure even if shutdown fails before the main flow awaits it.
    dbClosed.promise.catch(() => {});
    let drainResult, lateResult, lateOutcome, closedRows, detachedOutcome;
    let drainSettled = false, detachedRejected = false, requestStarted = false;
    try {
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,api_key_hash TEXT,name TEXT,email TEXT,tier TEXT,daily_limit INTEGER,enabled INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE user_daily_quota(user_id TEXT,day TEXT,used INTEGER,PRIMARY KEY(user_id,day));
      CREATE TABLE upstream_accounts(id TEXT PRIMARY KEY,status TEXT,state_revision INTEGER,credential_revision INTEGER,daily_quota INTEGER);
      CREATE TABLE account_429_v2_restrictions(kind TEXT,account_id TEXT);
      CREATE TABLE account_daily_reservations(account_id TEXT PRIMARY KEY,day TEXT,used INTEGER,legacy_ambiguous INTEGER);
      CREATE TABLE ordinary_account_attempts(account_id TEXT PRIMARY KEY,attempt_id TEXT);
      CREATE TABLE usage_logs(id TEXT PRIMARY KEY,user_id TEXT,upstream_account_id TEXT,timestamp TEXT,model TEXT,provider TEXT,input_tokens INTEGER,output_tokens INTEGER,usage_known INTEGER,success INTEGER,error TEXT,latency_ms INTEGER);`);
    const key='synthetic-client-key', crypto=require('crypto');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run('user-1',crypto.createHash('sha256').update(key).digest('hex'),'User','test@example.invalid','pro',10,1,new Date().toISOString(),new Date().toISOString());
    db.prepare('INSERT INTO upstream_accounts VALUES (?,?,?,?,?)').run('account-1','active',1,1,0);
    const logger={info(){},debug(){},warn(){},error(){}};
    let closed=false, lateCalls=0, realLateCalls=0, providerCalls=0, closeCallback, app, signal;
    const expectedRows=[{user_id:'user-1',upstream_account_id:'account-1',model:'gpt-5',input_tokens:2,output_tokens:3,success:1}];
    const client={getDb:()=>db, requireInitializedDatabase:()=>{if(closed) throw Error('closed'); return db;}, initDatabase(){}, closeDatabase(){
      try {
        closedRows=db.prepare('SELECT user_id,upstream_account_id,model,input_tokens,output_tokens,success FROM usage_logs').all();
        assert.deepEqual(closedRows,mode==='normal' ? expectedRows : []);
        db.close();
        assert.equal(db.open,false,'database must actually be closed');
        closed=true; events.push('db-close'); dbClosed.resolve();
      } catch (error) { dbClosed.reject(error); throw error; }
    }};
    const actualWriter=load('src/db/async-writer.ts',{'better-sqlite3':Database,'./client.js':client,'../utils/logger.js':{logger}});
    const writer={...actualWriter, withAsyncWriter(...args) {
      if (events.includes('response') && !events.includes('db-close')) {
        lateCalls++; events.push('late-enter'); entered.resolve();
        lateResult=release.promise.then(() => { realLateCalls++; events.push('real-writer'); return actualWriter.withAsyncWriter(...args); });
        // Record the exact writer outcome without creating an unhandled rejection.
        lateOutcome = lateResult.then(value => ({ok:true, value}), error => ({ok:false, error}));
        return lateResult;
      }
      return actualWriter.withAsyncWriter(...args);
    }};
    const work=load('src/request-work.ts',{'node:async_hooks':require('node:async_hooks')});
    const originalStopAndDrain=work.requestWork.stopAndDrain.bind(work.requestWork);
    work.requestWork.stopAndDrain=(...args)=>{
      drainEntered.resolve();
      drainResult=originalStopAndDrain(...args);
      drainResult.then(() => { drainSettled=true; events.push('request-drained'); }, () => { drainSettled=true; events.push('request-drain-failed'); });
      return drainResult;
    };
    const env={NODE_ENV:'test'};
    const encryption=load('src/utils/encryption.ts',{'crypto':crypto,'../config/env.js':{env}});
    const users=load('src/db/repositories/users.ts',{'../client.js':client,'crypto':crypto});
    const auth=load('src/auth/user-auth.ts',{'../db/repositories/users.js':users,'../utils/encryption.js':encryption,'../utils/logger.js':{logger},'../config/env.js':{env},'../db/async-writer.js':writer,'../request-work.js':work});
    const usage=load('src/db/repositories/usage-logs.ts',{'../client.js':client,'crypto':crypto,'../usage-utc.js':{parseUsageUtc(){throw Error('unexpected');}}});
    class UpstreamError extends Error {constructor(status,message){super(message);this.status=status;}}
    const inference={UpstreamError,isSiwcStream429:()=>false,async infer(_provider,_auth,_request,_unused,_signal,dispatch) {
      const response=await dispatch(async()=>{providerCalls++;return new Response('{}',{status:200});});
      assert.equal(response.status,200);
      return (async function*(){yield {text:'fixture answer'}; yield {finish:'stop',usage:{input:2,output:3}};})();
    }};
    const store={assert429V2Schema(){},arm429V2(){throw Error('unexpected');}};
    const quota=load('src/upstream/account-quota.ts',{'../db/async-writer.js':writer,'../db/account-429-v2-store.js':store,'../db/durable-ledger-foundation.js':{},'./inference.js':inference,'./oauth.js':{parseStoredCredentials:()=>undefined},'../db/repositories/accounts.js':{},'crypto':crypto});
    const account={id:'account-1',provider:'openai',credentialType:'api_key',credentials:'synthetic',stateRevision:1,credentialRevision:1};
    const pool={selectCandidate:async()=>({kind:'upstream',account}),recordSuccessAsync:async()=>{},recordFailureAsync:async()=>{throw Error('unexpected');}};
    const forward=load('src/upstream/forward-chat.ts',{'crypto':crypto,'events':require('events'),'../account-pool/manager.js':{accountPool:pool},'../db/repositories/usage-logs.js':usage,'../db/repositories/accounts.js':{RefreshIntentError:class extends Error {}},'../utils/logger.js':{logger},'./tokens.js':{resolveAuth:async()=>({kind:'api_key',token:'synthetic-upstream',observedAccount:account})},'./inference.js':inference,'./account-quota.js':quota,'../db/client.js':client,'../db/async-writer.js':writer,'../db/account-429-v2-store.js':store,'../utils/encryption.js':encryption,'./siwc-store.js':{},'./siwc-refresh.js':{},'../db/repositories/settings.js':{SettingsRepository:class {},STRATEGIES:['priority']},'./ordinary-429-deadline.js':{}});
    const observeDetached = promise => {
      // Attach to the very promise detached by the source mutation.
      promise.catch(() => { detachedRejected=true; });
      detachedOutcome = promise.then(() => ({ok:true}), () => { detachedRejected=true; return {ok:false}; });
    };
    const router=load('src/routes/v1.ts',{'express':express,'../auth/user-auth.js':auth,'../upstream/forward-chat.js':forward,'../request-work.js':work,'../utils/logger.js':{logger},'../config/env.js':{env}}, {observeDetached},mode==='mutant').default;
    const expressFacade=Object.assign(()=>{app=express(); app.listen=()=>({on(){},close(cb){events.push('listener-close');closeCallback=cb;},closeAllConnections(){throw Error('unexpected');}});return app;}, {json:express.json});
    const fakeProcess={hrtime:process.hrtime,on(name,fn){if(name==='SIGTERM') signal=fn;},exit(){throw Error('unexpected exit');},exitCode:0};
    const otherDrains=[];
    const resolvedStop=name=>()=>{events.push(name);const done=Promise.resolve().then(()=>events.push(name+'-drained'));otherDrains.push(done);return done;};
    load('src/server.ts',{'express':expressFacade,'./config/env.js':{env},'./utils/logger.js':{logger},'./upstream/oauth.js':{stopOAuth:resolvedStop('oauth')},'./upstream/siwc-login.js':{stopSiwc:resolvedStop('siwc'),noStoreSiwc(_q,_s,next){next();}},'./upstream/tokens.js':{drainTokenRefreshes:resolvedStop('tokens')},'./request-work.js':work,'./db/client.js':client,'./db/async-writer.js':writer,'./db/account-429-v2-store.js':store,'./db/account-429-v2-expiry.js':{Account429V2Expiry:class {start(){} stopAndDrain(){events.push('expiry');return Promise.resolve();}}},'./routes/v1.js':{__esModule:true,default:router},'./routes/admin.js':{__esModule:true,default:express.Router()}},{process:fakeProcess});
    assert.equal(typeof signal,'function','server startup failed');
    function request() {
      const payload=JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});
      let wire=''; const socket=new Writable({write(chunk,_enc,cb){wire+=chunk.toString();cb();}});
      sockets.push(socket);
      socket.remoteAddress='127.0.0.1';
      const req=new http.IncomingMessage(socket); req.method='POST';req.url='/v1/chat/completions';req.headers={authorization:`Bearer ${key}`,'content-type':'application/json','content-length':String(Buffer.byteLength(payload))};
      const res=new http.ServerResponse(req); res.assignSocket(socket);
      const end=res.end; res.end=function(...args){const result=end.apply(this,args); events.push('response'); return result;};
      const finished=deferred(); res.on('finish',()=>finished.resolve());
      requestStarted=true; app.handle(req,res,()=>{throw Error('unexpected app fallthrough');}); req.push(payload);req.push(null);
      return {res,finished:finished.promise,get wire(){return wire;}};
    }
    const first=request(); await first.finished; assert.equal(first.res.statusCode,200,'successful real route');
    assert.ok(first.wire.includes('fixture answer')); assert.equal(providerCalls,1);
    await entered.promise; assert.equal(lateCalls,1); assert.equal(realLateCalls,0);
    assert.equal(db.prepare('SELECT used FROM user_daily_quota WHERE user_id=?').get('user-1').used,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_logs').get().n,0);
    events.push('shutdown'); signal(); assert.equal(typeof closeCallback,'function'); closeCallback(); events.push('listener-callback');
    await drainEntered.promise;
    await Promise.all(otherDrains);
    if (mode==='mutant') {
      await dbClosed.promise;
      assert.equal(db.open,false,'mutant must close before the writer is released');
      assert.equal(realLateCalls,0); assert.deepEqual(closedRows,[]);
      assert.ok(events.indexOf('shutdown')<events.indexOf('db-close'));
      assert.equal(drainSettled,true);
      release.resolve();
      const outcome=await lateOutcome;
      assert.equal(outcome.ok,false,'DB-close-before-write must reject the actual writer');
      assert.ok(outcome.error instanceof Error && outcome.error.message==='closed','unexpected writer failure');
      assert.equal(realLateCalls,1);
      assert.deepEqual(await detachedOutcome,{ok:true});
      assert.equal(detachedRejected,false);
      return;
    }
    assert.equal(db.open,true,'database must stay open while the writer is held');
    assert.equal(closed,false); assert.equal(realLateCalls,0);
    assert.equal(drainSettled,false,'request drain must retain the held writer');
    assert.equal(work.requestWork.ownedDispatch(()=>assert.fail('new dispatch ran')),false);
    const second=request(); await second.finished; assert.equal(second.res.statusCode,503); assert.equal(providerCalls,1);
    release.resolve(); await dbClosed.promise; await drainResult; await lateResult;
    assert.equal((await lateOutcome).ok,true);
    assert.equal(lateCalls,1); assert.equal(realLateCalls,1);
    assert.equal(db.open,false); assert.deepEqual(closedRows,expectedRows);
    assert.ok(events.indexOf('response')<events.indexOf('late-enter') && events.indexOf('late-enter')<events.indexOf('shutdown') && events.indexOf('real-writer')<events.indexOf('db-close'));
    } finally {
      release.resolve();
      // A failed or still-running shutdown must not race database closure.
      let timer;
      const settled = Promise.allSettled([lateOutcome, drainResult, detachedOutcome].filter(Boolean));
      const completed = await Promise.race([
        settled.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
      ]);
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      // If dispatch began but shutdown never supplied its drain, work may still
      // be active. Let only this child terminate; do not close a shared handle.
      if (!completed || (requestStarted && !drainResult)) fatal();
      if (db.open) db.close();
    }
  }
  run().then(() => {
    // Give detached promise rejections a turn to reach the process guard.
    setImmediate(() => { clearTimeout(watchdog); console.log(`PASS ${mode} 1`); });
  }, fatal);
}
