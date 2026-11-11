import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const markers = ['synthetic-user-unique-9182','synthetic-A-unique-9182','synthetic-B-unique-9182'];
const hintCases = [];
if (process.argv[2] !== '--child') {
  for (const mode of ['finite','indefinite','stream','server-error','server-error-rollback']) test(`authenticated SIWC restriction: ${mode}`, {timeout:25000}, async () => {
    const result = await new Promise(resolve => {
      let done = false, closed = false, timedOut = false, overflow = false, childError = false, out = '', err = '';
      const child = spawn(process.execPath,[fileURLToPath(import.meta.url),'--child',mode],{env:{},cwd:process.cwd(),stdio:['ignore','pipe','pipe'],windowsHide:true});
      const timer = setTimeout(()=>{timedOut=true;child.kill()},15000);
      const grace = setTimeout(()=>{if (!done) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(); }},18000);
      function finish(code,signal) { if(done)return;done=true;clearTimeout(timer);clearTimeout(grace);resolve({closed,timedOut,overflow,childError,code,signal,out,err}); }
      child.on('error',()=>{childError=true});
      child.on('close',(code,signal)=>{closed=true;finish(code,signal)});
      for (const [stream,isErr] of [[child.stdout,false],[child.stderr,true]]) {
        stream.on('error',()=>{childError=true;child.kill()});
        stream.on('data',chunk=>{if(out.length+err.length+chunk.length>2048){overflow=true;child.kill();return} if(isErr)err+=chunk.toString('utf8');else out+=chunk.toString('utf8')});
      }
    });
    const category = ['FIRST','OPEN','SECOND','BEFORE','AFTER','INDEFINITE','SETUP','CLEANUP'].find(x=>result.out===`${x}\n`) ?? 'OTHER';
    assert.ok(result.closed && !result.timedOut && !result.overflow && !result.childError && result.signal===null,'child termination failed');
    assert.equal(result.code,0,`fixture failed: ${category}`);
    assert.equal(result.out === '',true,'unexpected fixture output'); assert.equal(result.err === '',true,'unexpected fixture error output');
  });
} else {
  const mode=process.argv[3];
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
    function Database(name, options) {
      if (name !== ':memory:' || options !== undefined) throw new Error('MEMORY_ONLY');
      return new NativeDatabase(':memory:');
    }
    const express = require('express');
    const crypto = require('node:crypto');

    const db = new Database(':memory:');
    let manager, expiry, primary = '', cleanupFailed = false, releaseWriter, pendingForward, shutdownStarted = false, shutdownClosed, shutdownDone, closeListener, context, processShim, fakeProcess, deadlineFired = false;
    const shutdownTimers = new Set();
    const check = (value, category) => { if (!value) throw new Error(category); };
    const bounded = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 3000); })]); }
      finally { clearTimeout(timer); }
    };
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
        const token = options?.headers?.authorization;
        const id = token === `Bearer ${markers[1]}` ? 'A' : token === `Bearer ${markers[2]}` ? 'B' : null;
        if (!id) { unknownCredential = true; throw new Error('UNKNOWN_CREDENTIAL'); }
        calls.push(id);
        if (id === 'A') ownedAttempt = db.prepare("SELECT account_id,attempt_id FROM siwc_account_attempts WHERE account_id='a'").get();
        if (id === 'A' && calls.filter(x => x === 'A').length === 1) {
          if (mode === 'stream') return new Response('data: {"type":"response.failed","sequence_number":0,"response":{"id":"fixture","status":"failed","error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}}\n\n', {status:200,headers:{'content-type':'text/event-stream'}});
          if (mode === 'server-error' || mode === 'server-error-rollback') return new Response(null, {status:503});
          return new Response(null, {status:429, headers:{'retry-after': mode === 'finite' ? '10' : 'invalid'}});
        }
        const output = [
          {type:'response.created',response:{id:'r',status:'in_progress'}},
          {type:'response.in_progress',response:{id:'r',status:'in_progress'}},
          {type:'response.output_item.added',output_index:0,item:{id:'m',type:'message',status:'in_progress',role:'assistant',content:[]}},
          {type:'response.content_part.added',item_id:'m',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
          {type:'response.output_text.delta',item_id:'m',output_index:0,content_index:0,delta:'hello'},
          {type:'response.output_text.done',item_id:'m',output_index:0,content_index:0,text:'hello'},
          {type:'response.content_part.done',item_id:'m',output_index:0,content_index:0,part:{type:'output_text',text:'hello',annotations:[]}},
          {type:'response.output_item.done',output_index:0,item:{id:'m',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'hello',annotations:[]}]}},
          {type:'response.completed',response:{id:'r',status:'completed',output:[{id:'m',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'hello',annotations:[]}]}]}}
        ].map(x => `data: ${JSON.stringify(x)}\n\n`).join('');
        return new Response(output, {status:200,headers:{'content-type':'text/event-stream'}});
      };
      const calls = [];
      context = vm.createContext({Date:FakeDate, process:processShim, console:Object.freeze({}), Promise, Buffer, AbortController, Response, TransformStream, TextDecoder, setTimeout, clearTimeout, fetch:localFetch});
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
      const schema = load('db/schema'); db.exec(schema.SQL_SCHEMA);
      db.exec('ALTER TABLE upstream_accounts ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0');
      const clientSource = read('db/client');
      for (const name of ['COOLDOWN_TABLE_SQL','ORDINARY_ATTEMPTS_SQL','SIWC_ATTEMPTS_SQL']) {
        const match = clientSource.match(new RegExp(`const ${name} = \\x60([\\s\\S]*?)\\x60;`));
        check(!!match, 'DDL'); db.exec(match[1]);
      }
      for (const name of ['account_daily_reservations','user_daily_quota']) {
        const match = clientSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`));
        check(!!match, 'DDL'); db.exec(match[0]);
      }
      db.pragma('foreign_keys = ON');
      const client = {getDb:() => db, requireInitializedDatabase:() => db};
      const env = {env:{ENCRYPTION_KEY:'00'.repeat(32), NODE_ENV:'test'}};
      const encryption = load('utils/encryption', {crypto, '../config/env.js':env});
      const writer = load('db/async-writer', {'better-sqlite3':Database, './client.js':client, '../utils/logger.js':{logger}});
      const v2 = load('db/account-429-v2-store');
      writer.withAsyncWriter(connection => v2.provision429V2(connection));
      const expiryModule = load('db/account-429-v2-expiry', {'./client.js':client, './async-writer.js':writer, './account-429-v2-store.js':v2});
      const expiryOptions = {onFailure:() => { throw new Error('EXPIRY_FAILURE'); }, monotonic:() => monotonic, setTimer:() => { throw new Error('UNEXPECTED_TIMER'); }, clearTimer:() => {}, intervalMs:1000, maxObservations:10, scanBatch:10};
      expiry = new expiryModule.Account429V2Expiry(expiryOptions);
      const work = load('request-work', {'node:async_hooks':require('node:async_hooks')});
      manager = new work.RequestWorkManager();
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
      const pool = load('account-pool/manager', {'../db/repositories/accounts.js':accounts, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/logger.js':{logger}, '../utils/encryption.js':encryption, '../upstream/siwc-store.js':siwcStore, '../upstream/oauth.js':oauth, '../db/usage-utc.js':usageUtc});
      const tokens = load('upstream/tokens', {'../db/repositories/accounts.js':accounts, '../db/async-writer.js':writer, '../utils/logger.js':{logger}, './oauth.js':oauth});
      const inference = load('upstream/inference');
      const ledger = load('db/durable-ledger-foundation', {'better-sqlite3':Database, 'node:crypto':crypto});
      const quota = load('upstream/account-quota', {'../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../db/durable-ledger-foundation.js':ledger, './inference.js':inference, './oauth.js':oauth, '../db/repositories/accounts.js':accounts, crypto});
      const deadline = load('upstream/ordinary-429-deadline');
      const forward = load('upstream/forward-chat', {'./passthrough.js':{parsePassthrough(){throw new Error('passthrough unused');},startPassthrough(){throw new Error('passthrough unused');},PassthroughHttpError:class extends Error{},PassthroughStreamFailure:class extends Error{},routerErrorBody:()=>({}),routerErrorFrame:()=>''},crypto, events:require('node:events'), '../account-pool/manager.js':pool, '../db/repositories/usage-logs.js':usage, '../db/repositories/accounts.js':accounts, '../utils/logger.js':{logger}, './tokens.js':tokens, './inference.js':inference, './account-quota.js':quota, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/encryption.js':encryption, './siwc-store.js':siwcStore, './siwc-refresh.js':siwcRefresh, '../db/repositories/settings.js':settings, './ordinary-429-deadline.js':deadline});
      const auth = load('auth/user-auth', {'../db/repositories/users.js':users, '../utils/encryption.js':encryption, '../utils/logger.js':{logger}, '../config/env.js':env, '../db/async-writer.js':writer, '../request-work.js':{requestWork:manager}});
      const router = load('routes/v1', {express, '../config/env.js':env, '../auth/user-auth.js':auth, '../request-work.js':{requestWork:manager}, '../utils/logger.js':{logger}, '../upstream/forward-chat.js':{forwardMessages(_req,res){res.status(501).json({error:{type:'not_implemented',message:'fixture'}});},forwardResponses(_req,res){res.status(501).json({error:{type:'not_implemented',message:'fixture'}});},anthropicErrorEnvelope(){},anthropicErrorBody:(_s,message)=>({type:'error',error:{type:'api_error',message}}),forwardChat:async (req,res) => { req.fixtureEntered(); try { return await forward.forwardChat(req,res); } catch (error) { req.fixtureFailed(); throw error; } finally { req.fixtureFinished(); } }}}).default;
      const user = new users.UserRepository().create({apiKeyHash:encryption.hashApiKey(markers[0]),name:'fixture',email:'fixture@example.invalid',tier:'free',dailyLimit:10});
      db.exec(`CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL);
        CREATE TABLE siwc_access_policy(account_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,scope TEXT NOT NULL);
        CREATE TABLE siwc_access_users(account_id TEXT,user_id TEXT,PRIMARY KEY(account_id,user_id));
        CREATE TABLE siwc_routing_settings(account_id TEXT PRIMARY KEY,priority INTEGER,weight INTEGER);
        CREATE TABLE siwc_usage_logs(id TEXT PRIMARY KEY,user_id TEXT,account_id TEXT,timestamp TEXT,model TEXT,provider TEXT,input_tokens INTEGER,output_tokens INTEGER,success INTEGER,aborted INTEGER,status INTEGER,latency_ms INTEGER);
        INSERT INTO siwc_accounts VALUES('a','A'),('b','B');
        INSERT INTO siwc_access_policy VALUES('a',1,'all'),('b',1,'all');
        INSERT INTO siwc_routing_settings VALUES('a',0,1),('b',10,1);`);
      const store = new siwcStore.SiwcStore(db, new encryption.CredentialVault());
      for (const [id, token] of [['a',markers[1]],['b',markers[2]]]) store.create(id,{issuer:'https://auth.openai.com',subject:'fixture',clientId:`client-${id}`,accessToken:token,idToken:'fixture-id',tokenType:'Bearer',expiresIn:86400,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date(wall).toISOString()});
      function startRequest(key = markers[0]) {
        let finish, completed;
        let forwardEntered = false, forwardFailed = false, routerError = false, unmatched = false;
        const responseDone = new Promise(resolve => { finish = resolve; });
        const forwardDone = new Promise(resolve => { completed = resolve; });
        const res = Object.assign(new EventEmitter(), {statusCode:200, destroyed:false, writableEnded:false, headersSent:false, responseCount:0, headers:{}, status(code){this.statusCode=code;return this;}, setHeader(k,v){this.headers[k.toLowerCase()]=v;}, getHeader(k){return this.headers[k.toLowerCase()];}, json(body){this.responseCount++;this.body=body;this.headersSent=true;this.writableEnded=true;finish();return this;}, destroy(){this.responseCount++;this.destroyed=true;finish();}});
        const req = {method:'POST',url:'/chat/completions',headers:{authorization:`Bearer ${key}`},body:{model:'gpt-5',messages:[{role:'user',content:'hello'}]},fixtureFinished:completed};
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
      const denied = startRequest('incorrect-fixture-key');
      await bounded(denied.responseDone); auditRequest(denied, false);
      check([401,403].includes(denied.res.statusCode) && calls.length===0,'FIRST');
      let rollbackCheckpoint=false, rollbackErrorObserved=false;
      if (mode==='server-error-rollback') {
        db.function('fixture_observe', (restricted, owned) => {
          rollbackCheckpoint = db.inTransaction && restricted===1 && owned===1;
          return 1;
        });
        db.exec("CREATE TRIGGER fixture_reject_siwc_open_delete BEFORE DELETE ON siwc_account_attempts BEGIN SELECT fixture_observe(EXISTS(SELECT 1 FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id=OLD.account_id), EXISTS(SELECT 1 FROM siwc_account_attempts WHERE account_id=OLD.account_id AND attempt_id=OLD.attempt_id)); SELECT RAISE(ABORT, 'synthetic siwc delete failure'); END");
        const originalWriter=writer.withAsyncWriter;
        const observe=error=>{if(error?.code==='SQLITE_CONSTRAINT_TRIGGER' && error.message==='synthetic siwc delete failure')rollbackErrorObserved=true;throw error;};
        writer.withAsyncWriter=(...args)=>{try{const result=originalWriter(...args);return result instanceof Promise?result.catch(observe):result;}catch(error){return observe(error);}};
      }
      const first = await request();
      check(first.statusCode===(mode.startsWith('server-error') ? 503 : 429) && first.responseCount===1 && JSON.stringify(calls)==='["A"]','FIRST');
      if (mode==='server-error-rollback') {
        check(rollbackCheckpoint && rollbackErrorObserved && ownedAttempt?.account_id==='a' && !!ownedAttempt.attempt_id && !!db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id=? AND attempt_id=?").get('a',ownedAttempt.attempt_id) && !db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='a'").get(),'OPEN');
      } else {
      check(ownedAttempt?.account_id==='a' && !!ownedAttempt.attempt_id && !db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get(), 'OPEN');
      const row = () => db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='a'").get();
      const duration = mode==='finite' ? 10000 : mode==='stream' ? 5000 : mode==='server-error' ? 6000 : null;
      check(!!row() && row().duration_ms === duration,'FIRST');
      await expiry.tick();
      const second=await request();
      check(second.statusCode===200 && JSON.stringify(calls)==='["A","B"]','SECOND');
      monotonic += mode==='stream' ? 4999999999n : mode==='server-error' ? 5999999999n : 9999999999n; wall += 12000; await expiry.tick();
      check(!!row(),'BEFORE');
      const third=await request();
      check(third.statusCode===200 && JSON.stringify(calls)==='["A","B","B"]','BEFORE');
      monotonic += 1n; await expiry.tick();
      if (mode!=='indefinite') {
        check(!row(),'AFTER');
        const fourth=await request();
        check(fourth.statusCode===200 && JSON.stringify(calls)==='["A","B","B","A"]','AFTER');
      } else {
        monotonic += 100000000000000n; await expiry.tick();
        check(row()?.duration_ms===null,'INDEFINITE');
        const fourth=await request();
        check(fourth.statusCode===200 && JSON.stringify(calls)==='["A","B","B","B"]','INDEFINITE');
      }
      }
      await expiry.stopAndDrain();
    } catch (error) {
      primary = error instanceof Error && ['FIRST','OPEN','SECOND','BEFORE','AFTER','INDEFINITE'].includes(error.message) ? error.message : 'SETUP';
    } finally {
      if (expiry) { try { await bounded(expiry.stopAndDrain()); } catch { cleanupFailed = true; } }
      if (manager) { try { await bounded(manager.stopAndDrain()); } catch { cleanupFailed = true; } }
      if (db.open) { try { db.close(); if(db.open) cleanupFailed=true; } catch { cleanupFailed=true; } }
    }
    if (cleanupFailed || primary) { process.stdout.write(`${cleanupFailed?'CLEANUP':primary}\n`); process.exitCode=1; }
  } catch { process.stdout.write('SETUP\n'); process.exitCode=1; }
}
