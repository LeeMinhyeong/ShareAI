import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const markers=['synthetic-user-5xx-4731','sk-ant-api-synthetic-A-5xx-4731','sk-ant-api-synthetic-B-5xx-4731'];
const hintCases=[];
if (process.argv[2] !== '--worker') {
 test('authenticated 5xx restriction across router processes',{timeout:60000},async t=>{
  const root=resolve(process.cwd()); const dir=mkdtempSync(join(root,'test-5xx-owned-')); const dbPath=join(dir,'fixture.sqlite');
  assert.ok(resolve(dir).startsWith(root+sep),'invalid owned directory');
  const children=[];
  async function worker(initialize,providerMode='http',file=dbPath) {
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker',file,initialize?'init':'open',providerMode],{cwd:dir,env:{},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
   let output=0, overflow=false, failed=false, exited=false, code, signal;
   for(const stream of [child.stdout,child.stderr]) {stream.on('data',b=>{output+=b.length;if(output>1024){overflow=true;child.kill()}});stream.on('error',()=>{failed=true;child.kill()});}
   child.on('error',()=>{failed=true});
   const closed=new Promise(resolve=>child.once('close',(c,s)=>{exited=true;code=c;signal=s;resolve()}));
   const record={child,closed,verify:()=>assert.ok(exited && code===0 && signal===null && !overflow && !failed,'worker close failed'),isClosed:()=>exited}; children.push(record);
   let timer;
   const result=await Promise.race([new Promise(resolve=>child.once('message',resolve)),closed.then(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),12000)})]);clearTimeout(timer);
   if (!result) {child.kill(); await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,3000))]); throw Error('worker failed before result');}
   if (['SCHEMA','MODULES','PROVISION','LOAD','WORK','OAUTH','POOL','TOKENS','INFERENCE','LEDGER','QUOTA','DEADLINE','FORWARD','ROUTER','ACCOUNTS','AUTH','REQUEST','CLEANUP'].includes(result.failure)) throw Error(`worker failed: ${result.failure}`);
   if (!(result && Number.isInteger(result.status) && result.status>=100 && result.status<=599 && Number.isInteger(result.a) && result.a>=0 && result.a<=10 && Number.isInteger(result.b) && result.b>=0 && result.b<=10 && ['openDuring','openAfter','restricted','authDenied'].every(k=>typeof result[k]==='boolean'))) { child.kill(); throw Error('invalid worker result'); }
   return {...record,result};
  }
  async function stop(w){if(w.child.connected)w.child.send('stop');await Promise.race([w.closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('worker close timeout')),5000))]);w.verify()}
  let first,second,restarted,network,local,rollback,overlap,overlapUnknown,taskError;
  try {
    first=await worker(true); second=await worker(false); await stop(second); restarted=await worker(false); network=await worker(true,'network',join(dir,'network.sqlite')); local=await worker(true,'local',join(dir,'local.sqlite'));
    rollback=await worker(true,'rollback',join(dir,'rollback.sqlite'));
    overlap=await worker(true,'overlap',join(dir,'overlap.sqlite'));
    overlapUnknown=await worker(true,'overlap-unknown',join(dir,'overlap-unknown.sqlite'));
    assert.ok(!first.isClosed() && first.child.exitCode===null && first.child.signalCode===null,'first router did not stay alive');
    const f=first.result,s=second.result,r=restarted.result;
    await t.test('provider 503 is sent once and owns OPEN',()=>{assert.equal(f.authDenied,true);assert.equal(f.status,503);assert.equal(f.a,1);assert.equal(f.b,0);assert.equal(f.openDuring,true);assert.equal(f.openAfter,false)});
    await t.test('provider 503 restriction and OPEN settle together',()=>{assert.equal(f.restricted,true,'shared 5xx restriction absent after OPEN settlement')});
    await t.test('second live router selects B',()=>{assert.deepEqual([s.a,s.b],[0,1],'second router provider calls [A,B]');assert.equal(s.status,200)});
    await t.test('restarted router selects B',()=>{assert.deepEqual([r.a,r.b],[0,1],'restarted router provider calls [A,B]');assert.equal(r.status,200)});
    await t.test('network failure retains uncertain OPEN',()=>{const n=network.result;assert.equal(n.a,1);assert.equal(n.b,0);assert.equal(n.openDuring,true);assert.equal(n.openAfter,true);assert.equal(n.restricted,false);assert.equal(n.status,502)});
    await t.test('local 503 has no provider dispatch',()=>{const n=local.result;assert.equal(n.status,503);assert.equal(n.a,0);assert.equal(n.b,0);assert.equal(n.openDuring,false);assert.equal(n.openAfter,false)});
    await t.test('failed OPEN deletion rolls back the 5xx restriction',()=>{const n=rollback.result;assert.equal(n.providerStatus,503);assert.equal(n.rollbackCheckpoint,true);assert.equal(n.rollbackErrorObserved,true);assert.equal(n.status,503);assert.equal(n.a,1);assert.equal(n.b,0);assert.equal(n.openDuring,true);assert.equal(n.openAfter,true);assert.equal(n.restricted,false)});
    await t.test('5xx does not shorten an existing 429 restriction',()=>{const n=overlap.result;assert.equal(n.providerStatus,503);assert.equal(n.overlapArmed,true);assert.equal(n.status,503);assert.equal(n.a,1);assert.equal(n.openAfter,false);assert.equal(n.restricted,true);assert.equal(n.restrictedDuration,10000)});
    await t.test('5xx preserves an indefinite 429 restriction',()=>{const n=overlapUnknown.result;assert.equal(n.providerStatus,503);assert.equal(n.overlapArmed,true);assert.equal(n.status,503);assert.equal(n.a,1);assert.equal(n.openAfter,false);assert.equal(n.restricted,true);assert.equal(n.restrictedDuration,null)});
  } catch(error) {taskError=error;} finally {
    let cleanupFailed=false;
    for(const w of children) if(!w.isClosed()) {try{await stop(w)}catch{cleanupFailed=true;w.child.kill();await Promise.race([w.closed,new Promise(resolve=>setTimeout(resolve,3000))]);}}
    for(const w of children) {if(!w.isClosed()){w.child.kill();throw Error('child termination not confirmed; fixture preserved')} try{w.verify()}catch{cleanupFailed=true}}
    rmSync(dir,{recursive:true,force:true});
    if(cleanupFailed) { if(taskError) throw new AggregateError([taskError,Error('worker cleanup failed')],'fixture and cleanup failed'); throw Error('worker cleanup failed'); }
  }
  if(taskError) throw taskError;
 });
} else {
 const databasePath=process.argv[3],initialize=process.argv[4]==='init',providerMode=process.argv[5];
  try {
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const { EventEmitter } = await import('node:events');
    const vm = await import('node:vm');
    const require = createRequire(import.meta.url);
    // Install before loading any third-party package. IPC/stdio already exist;
    // these replacements never create a socket or listener.
    const denied = () => { throw new Error('HOST_NETWORK_DENIED'); };
    const http = require('node:http'), https = require('node:https');
    const net = require('node:net'), dns = require('node:dns');
    globalThis.fetch = denied;
    http.request = http.get = https.request = https.get = denied;
    net.Socket.prototype.connect = net.Server.prototype.listen = denied;
    dns.lookup = dns.resolve = denied;
    for (const key of Object.keys(dns)) if (key.startsWith('resolve') && typeof dns[key] === 'function') dns[key] = denied;
    dns.promises.lookup = dns.promises.resolve = denied;
    for (const key of Object.keys(dns.promises)) if (key.startsWith('resolve') && typeof dns.promises[key] === 'function') dns.promises[key] = denied;
    // Synchronize Node's ESM named built-in exports with guarded CJS exports.
    syncBuiltinESMExports();
    for (const fn of [globalThis.fetch, http.request, http.get, https.request, https.get, net.Socket.prototype.connect, net.Server.prototype.listen, dns.lookup, dns.resolve, dns.promises.lookup, dns.promises.resolve]) {
      let blocked = false;
      try { fn(); } catch (error) { blocked = error instanceof Error && error.message === 'HOST_NETWORK_DENIED'; }
      if (!blocked) throw new Error('HOST_GUARD_FAILURE');
    }
    const ts = require('typescript');
    const NativeDatabase = require('better-sqlite3');
    let rollbackCheckpoint=false, rollbackErrorObserved=false, overlapArmed=false, providerStatus=0;
    function Database(name, options) {
      if (name === ':memory:' && options === undefined) return new NativeDatabase(':memory:');
      if (name !== databasePath || (options !== undefined && !(options.timeout === 0 && options.fileMustExist === true && Object.keys(options).length === 2))) throw new Error('ISOLATED_DATABASE_ONLY');
      const connection = new NativeDatabase(databasePath, options ?? (initialize ? {} : {fileMustExist:true}));
      if (providerMode === 'rollback') connection.function('fixture_observe', (restricted, owned) => {
        rollbackCheckpoint = connection.inTransaction && restricted === 1 && owned === 1;
        return 1;
      });
      return connection;
    }
    const express = require('express');
    const crypto = require('node:crypto');

    const db = new Database(databasePath);
    let manager, expiry, primary = '', cleanupFailed = false, releaseWriter, pendingForward, shutdownStarted = false, shutdownClosed, shutdownDone, closeListener, context, processShim, fakeProcess, deadlineFired = false;
    const shutdownTimers = new Set();
    const check = (value, category) => { if (!value) throw new Error(category); };
    const bounded = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 3000); })]); }
      finally { clearTimeout(timer); }
    };
    let stage='SCHEMA';
    try {
      const hintArg = process.argv.find(arg => arg.startsWith('--hint-case='));
      const hintCase = hintArg === undefined ? undefined : hintCases[Number(hintArg.slice('--hint-case='.length))];
      check(hintArg === undefined || hintCase !== undefined, 'FIXTURE_FAILURE');
      let wall = hintCase ? Date.parse('1994-11-06T08:49:37.000Z') + (hintCase.skew ?? 0) : Date.parse('2031-07-01T00:00:00.000Z');
      let monotonic = 5000000000n;
      class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } static now() { return wall; } }
      const logger = Object.freeze({debug(){}, info(){}, warn(){}, error(){}});
      processShim = Object.freeze({env:Object.freeze(Object.create(null)), hrtime:Object.freeze({bigint:() => monotonic})});
      let unknownCredential = false, ownedAttempt;
      const localFetch = async (_url, options) => {
        const token = options?.headers?.['x-api-key'];
        const id = token === markers[1] ? 'A' : token === markers[2] ? 'B' : null;
        if (!id) { unknownCredential = true; throw new Error('UNKNOWN_CREDENTIAL'); }
        calls.push(id);
        ownedAttempt = db.prepare('SELECT account_id,attempt_id FROM ordinary_account_attempts').get();
        if (providerMode === 'network') throw new Error('synthetic-network-failure');
        if (id === 'A' && (providerMode === 'overlap' || providerMode === 'overlap-unknown')) {
          // Wait until the dispatch transaction has committed before the
          // independent restriction is armed while the provider is in flight.
          await Promise.resolve();
          await writer.withAsyncWriter(connection => v2.arm429V2(connection, 'upstream', ownedAttempt.account_id, providerMode === 'overlap' ? 10000 : null));
          overlapArmed = true;
        }
        if (id === 'A') { providerStatus=503; return new Response(null,{status:503}); }
        const events = [
          {type:'message_start',message:{id:'synthetic',content:[],usage:{input_tokens:1}}},
          {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture'}},
          {type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
          {type:'message_stop'},
        ].map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
        return new Response(events,{status:200,headers:{'content-type':'text/event-stream'}});
      };
      const calls = [];
      context = vm.createContext({Date:FakeDate, process:processShim, console:Object.freeze({}), Promise, Buffer, AbortController, Response, TransformStream, TextDecoder, setTimeout, clearTimeout, performance:require('node:perf_hooks').performance, fetch:localFetch});
      const read = path => readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8');
      function load(path, dependencies = {}) {
        let input = read(path);
        if (path === 'db/account-429-v2-expiry' && process.argv.includes('--early-mutant')) {
          for (const expression of ['now - observation.since < row.duration_ms * 1000000n', 'lockedNow - observation.since < row.duration_ms * 1000000n']) {
            check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
            input = input.replace(expression, expression + ' - 1n');
          }
        }
        if (path === 'db/account-429-v2-expiry' && process.argv.includes('--restart-mutant')) {
          const expression = 'this.observations.set(key, {row, since: this.sample()});';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, 'this.observations.set(key, {row, since: this.sample() - (globalThis.fixtureRestarted ? 5000000000n : 0n)});');
        }
        if (path === 'db/account-429-v2-expiry' && process.argv.includes('--indefinite-mutant')) {
          const expression = 'if (row.duration_ms === null || this.observations.has(key) || this.observations.size >= this.o.maxObservations) continue;';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, "if (row.duration_ms === null) { db.prepare('DELETE FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=? AND generation=? AND duration_ms IS NULL').run(row.kind, row.account_id, row.generation); continue; }\n      if (this.observations.has(key) || this.observations.size >= this.o.maxObservations) continue;");
        }
        if (path === 'server' && process.argv.includes('--shutdown-mutant')) {
          const expression = '    requestDrain,\n';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, '    Promise.resolve(true),\n');
        }
        const source = ts.transpileModule(input, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
        const exports = {};
        const factory = new vm.Script(`(function(exports, require, module){${source}\n})`, {filename:`${path}.ts`}).runInContext(context);
        const module = {exports};
        factory(exports, name => { if (!Object.hasOwn(dependencies, name)) throw new Error('UNEXPECTED_IMPORT'); return dependencies[name]; }, module);
        return module.exports;
      }
      if (initialize) {
      const schema = load('db/schema'); db.exec(schema.SQL_SCHEMA);
      db.exec('ALTER TABLE upstream_accounts ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0');
      const clientSource = read('db/client');
      for (const name of ['COOLDOWN_TABLE_SQL','ORDINARY_ATTEMPTS_SQL']) {
        const match = clientSource.match(new RegExp(`const ${name} = \\x60([\\s\\S]*?)\\x60;`));
        check(!!match, 'DDL'); db.exec(match[1]);
      }
      for (const name of ['account_daily_reservations','user_daily_quota']) {
        const match = clientSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`));
        check(!!match, 'DDL'); db.exec(match[0]);
      }
      }
      db.pragma('foreign_keys = ON');
      stage='MODULES';
      const client = {getDb:() => db, requireInitializedDatabase:() => db};
      const env = {env:{ENCRYPTION_KEY:'00'.repeat(32), NODE_ENV:'test'}};
      const encryption = load('utils/encryption', {crypto, '../config/env.js':env});
      const writer = load('db/async-writer', {'better-sqlite3':Database, './client.js':client, '../utils/logger.js':{logger}});
      if (providerMode === 'rollback') {
        const originalWriter = writer.withAsyncWriter;
        const observe = error => {
          if (error?.code === 'SQLITE_CONSTRAINT_TRIGGER' && error.message === 'synthetic delete failure') rollbackErrorObserved = true;
          throw error;
        };
        writer.withAsyncWriter = (...args) => {
          try { const result = originalWriter(...args); return result instanceof Promise ? result.catch(observe) : result; }
          catch (error) { return observe(error); }
        };
      }
      const v2 = load('db/account-429-v2-store');
      stage='PROVISION';
      if (initialize) await writer.withAsyncWriter(connection => v2.provision429V2(connection));
      stage='LOAD';
      const expiryModule = load('db/account-429-v2-expiry', {'./client.js':client, './async-writer.js':writer, './account-429-v2-store.js':v2});
      const expiryOptions = {onFailure:() => { throw new Error('EXPIRY_FAILURE'); }, monotonic:() => monotonic, setTimer:() => { throw new Error('UNEXPECTED_TIMER'); }, clearTimer:() => {}, intervalMs:1000, maxObservations:10, scanBatch:10};
      expiry = new expiryModule.Account429V2Expiry(expiryOptions);
      stage='WORK';
      const work = load('request-work', {'node:async_hooks':require('node:async_hooks')});
      manager = new work.RequestWorkManager();
      stage='OAUTH';
      const oauth = load('upstream/oauth', {crypto, http:Object.freeze({}), '../utils/logger.js':{logger}});
      const accounts = load('db/repositories/accounts', {'../client.js':client, crypto, '../../upstream/oauth.js':oauth, '../../utils/encryption.js':encryption});
      const users = load('db/repositories/users', {'../client.js':client, crypto});
      const usageUtc = load('db/usage-utc');
      const usage = load('db/repositories/usage-logs', {'../client.js':client, crypto, '../usage-utc.js':usageUtc});
      const settings = load('db/repositories/settings', {'../client.js':client});
      const siwcStore = load('upstream/siwc-store', {'better-sqlite3':Database, 'node:crypto':crypto});
      // This fixture covers ordinary Anthropic API-key accounts only.
      let refreshCalls = 0;
      const siwcRefresh = Object.freeze({refreshSiwcSnapshot() { refreshCalls++; throw new Error('SIWC_REFRESH_DENIED'); }});
      stage='POOL';
      const pool = load('account-pool/manager', {'../db/repositories/accounts.js':accounts, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/logger.js':{logger}, '../utils/encryption.js':encryption, '../upstream/siwc-store.js':siwcStore, '../upstream/oauth.js':oauth, '../db/usage-utc.js':usageUtc});
      stage='TOKENS';
      const tokens = load('upstream/tokens', {'../db/repositories/accounts.js':accounts, '../db/async-writer.js':writer, '../utils/logger.js':{logger}, './oauth.js':oauth});
      stage='INFERENCE';
      const inference = load('upstream/inference');
      stage='LEDGER';
      const ledger = load('db/durable-ledger-foundation', {'better-sqlite3':Database, 'node:crypto':crypto});
      stage='QUOTA';
      const quota = load('upstream/account-quota', {'../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../db/durable-ledger-foundation.js':ledger, './inference.js':inference, './oauth.js':oauth, '../db/repositories/accounts.js':accounts, crypto});
      stage='DEADLINE';
      const deadline = load('upstream/ordinary-429-deadline');
      stage='FORWARD';
      const forward = load('upstream/forward-chat', {crypto, events:require('node:events'), '../account-pool/manager.js':pool, '../db/repositories/usage-logs.js':usage, '../db/repositories/accounts.js':accounts, '../utils/logger.js':{logger}, './tokens.js':tokens, './inference.js':inference, './account-quota.js':quota, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/encryption.js':encryption, './siwc-store.js':siwcStore, './siwc-refresh.js':siwcRefresh, '../db/repositories/settings.js':settings, './ordinary-429-deadline.js':deadline});
      const auth = load('auth/user-auth', {'../db/repositories/users.js':users, '../utils/encryption.js':encryption, '../utils/logger.js':{logger}, '../config/env.js':env, '../db/async-writer.js':writer, '../request-work.js':{requestWork:manager}});
      stage='ROUTER';
      const router = load('routes/v1', {express, '../config/env.js':env, '../auth/user-auth.js':auth, '../request-work.js':{requestWork:manager}, '../utils/logger.js':{logger}, '../upstream/forward-chat.js':{forwardChat:async (req,res) => { req.fixtureEntered(); try { return await forward.forwardChat(req,res); } catch (error) { req.fixtureFailed(); throw error; } finally { req.fixtureFinished(); } }}}).default;
      stage='ACCOUNTS';
      let aId;
      if (initialize) {
        new users.UserRepository().create({apiKeyHash:encryption.hashApiKey(markers[0]),name:'fixture',email:'fixture@example.invalid',tier:'free',dailyLimit:100});
        const repo = new accounts.AccountRepository();
        aId = repo.create({name:'A',provider:'anthropic',credentialType:'api_key',credentials:markers[1],priority:0}).id;
        repo.create({name:'B',provider:'anthropic',credentialType:'api_key',credentials:markers[2],priority:1});
      } else aId = db.prepare("SELECT id FROM upstream_accounts WHERE name='A'").get().id;
      function startRequest(key = markers[0]) {
        let finish, completed;
        let forwardEntered = false, forwardFailed = false, routerError = false, unmatched = false;
        const responseDone = new Promise(resolve => { finish = resolve; });
        const forwardDone = new Promise(resolve => { completed = resolve; });
        const res = Object.assign(new EventEmitter(), {statusCode:200, destroyed:false, writableEnded:false, headersSent:false, headers:{}, status(code){this.statusCode=code;return this;}, setHeader(k,v){this.headers[k.toLowerCase()]=v;}, getHeader(k){return this.headers[k.toLowerCase()];}, json(body){this.body=body;this.headersSent=true;this.writableEnded=true;finish();return this;}, destroy(){this.destroyed=true;finish();}});
        const req = {method:'POST',url:'/chat/completions',headers:{authorization:`Bearer ${key}`},body:{model:'claude-fixture',messages:[{role:'user',content:'hello'}]},fixtureFinished:completed};
        req.fixtureEntered = () => { forwardEntered = true; };
        req.fixtureFailed = () => { forwardFailed = true; };
        router.handle(req,res,error => { routerError = !!error; unmatched = !error; if (!res.writableEnded) res.status(error ? 500 : 404).json({}); });
        return {res, responseDone, forwardDone, audit:() => ({forwardEntered, forwardFailed, routerError, unmatched})};
      }
      function auditRequest(result, expectForward = true) {
        const {res} = result;
        const {forwardEntered, forwardFailed, routerError, unmatched} = result.audit();
        check(!unknownCredential, 'UNKNOWN_CREDENTIAL');
        check(refreshCalls === 0, 'SIWC_REFRESH_CALLED');
        check(!routerError, 'ROUTER_ERROR');
        check(!unmatched, 'NOT_FOUND');
        check(forwardEntered === expectForward, res.statusCode === 401 || res.statusCode === 403 ? 'AUTH_REJECTED' : 'PRE_FORWARD_ERROR');
        check(!forwardFailed, 'FORWARD_ERROR');
      }
      async function request() {
        const result = startRequest();
        const {res, responseDone, forwardDone} = result;
        await bounded(responseDone);
        if (result.audit().forwardEntered) await bounded(forwardDone);
        auditRequest(result);
        return res;
      }
      stage='AUTH';
      const denied = startRequest('invalid-fixture-key');
      await bounded(denied.responseDone); auditRequest(denied,false);
      const authDenied = [401,403].includes(denied.res.statusCode) && calls.length===0;
      if (providerMode==='local') db.prepare("UPDATE upstream_accounts SET status='disabled'").run();
      if (providerMode==='rollback') db.exec("CREATE TRIGGER fixture_reject_open_delete BEFORE DELETE ON ordinary_account_attempts BEGIN SELECT fixture_observe(EXISTS(SELECT 1 FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=OLD.account_id), EXISTS(SELECT 1 FROM ordinary_account_attempts WHERE account_id=OLD.account_id AND attempt_id=OLD.attempt_id)); SELECT RAISE(ABORT, 'synthetic delete failure'); END");
      stage='REQUEST';
      const response = await request();
      const restriction = db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(aId);
      const observed = {status:response.statusCode,a:calls.filter(x=>x==='A').length,b:calls.filter(x=>x==='B').length,openDuring:ownedAttempt?.account_id===aId && typeof ownedAttempt?.attempt_id==='string' && ownedAttempt.attempt_id.length>0,openAfter:!!db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(aId),restricted:!!restriction,restrictedDuration:restriction?.duration_ms ?? null,rollbackCheckpoint,rollbackErrorObserved,overlapArmed,providerStatus,authDenied};
      await new Promise((resolve,reject)=>process.send(observed,error=>error?reject(error):resolve()));
      await new Promise(resolve=>process.once('message',resolve));
    } catch { primary='FIXTURE_FAILURE'; if(process.connected) await new Promise(resolve=>process.send({failure:stage},()=>resolve())); }
    finally {
      if (manager) { try { await bounded(manager.stopAndDrain()); } catch { cleanupFailed=true; } }
      if (db.open) { try { db.close(); if(db.open) cleanupFailed=true; } catch {cleanupFailed=true;} }
    }
    if(primary || cleanupFailed) process.exitCode=1;
  } catch { process.exitCode=1; }
}
