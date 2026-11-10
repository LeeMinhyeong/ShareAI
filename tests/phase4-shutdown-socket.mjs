// Focused loopback fixture, outside the default test glob.
// Static safety review completed; JavaScript guards are not a native sandbox.
// Capture these originals in the isolated child BEFORE installing its deny guards.
export function makeOwnedLoopbackHarness(http, net) {
  const listen = net.Server.prototype.listen;
  const connect = net.Socket.prototype.connect;
  const request = http.request;
  const createServer = http.createServer;
  let server, address, activeRequest, activeSocket;

  function bounded(promise, ms = 3000) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SOCKET_TIMEOUT')), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async function bind() {
    if (server) throw new Error('SOCKET_ALREADY_BOUND');
    for (let port = 43000; port <= 43015; port++) {
      // Only the test harness can invoke the saved listen method.
      const candidate = createServer();
      const result = new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.once('listening', () => resolve(candidate.address()));
        listen.call(candidate, {host:'127.0.0.1', port, exclusive:true});
      });
      try {
        const bound = await bounded(result);
        if (!bound || bound.address !== '127.0.0.1' || bound.port !== port || !candidate.listening) {
          throw new Error('SOCKET_BAD_BIND');
        }
        // Keep an error handler after startup; do not expose arbitrary errors.
        candidate.on('error', () => {});
        server = candidate;
        address = bound;
        return port;
      } catch (error) {
        // An in-flight bind must not be abandoned: a late successful listen is
        // closed, and the parent must terminate/reap this child on timeout.
        candidate.once('listening', () => candidate.close());
        if (candidate.listening) candidate.close();
        if (error?.message === 'HOST_NETWORK_DENIED') throw new Error('SOCKET_BIND_GUARD');
        if (error?.code !== 'EADDRINUSE') throw new Error('SOCKET_BIND_FAILED');
      }
    }
    throw new Error('SOCKET_NO_CANDIDATE');
  }

  // Called only by the fixture's express facade, not by production code as a
  // general network function. The production app receives only this server.
  function attach(app, port, host, callback) {
    if (!server || !server.listening || host !== '127.0.0.1' || port !== address.port || server.listenerCount('request') !== 0) {
      throw new Error('SOCKET_ATTACH_FAILED');
    }
    server.on('request', app);
    queueMicrotask(callback);
    return server;
  }

  async function post(body, authorization) {
    if (!server?.listening || !address || activeRequest) throw new Error('SOCKET_NOT_READY');
    const payload = JSON.stringify(body);
    let socketClosed;
    const closed = new Promise(resolve => { socketClosed = resolve; });
    const response = new Promise((resolve, reject) => {
      const agent = new http.Agent({keepAlive:false});
      agent.createConnection = () => {
        if (!server.listening) throw new Error('SOCKET_NOT_READY');
        const socket = activeSocket = new net.Socket();
        socket.once('close', socketClosed);
        connect.call(socket, {host:'127.0.0.1', port:address.port});
        return socket;
      };
      const req = activeRequest = request({
        host:'127.0.0.1', port:address.port, path:'/v1/chat/completions', method:'POST', agent,
        headers:{authorization, 'content-type':'application/json', 'content-length':Buffer.byteLength(payload), connection:'close'},
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
          if (text.length > 65536) req.destroy(new Error('SOCKET_RESPONSE_TOO_LARGE'));
        });
        res.once('error', reject);
        res.once('aborted', () => reject(new Error('SOCKET_RESPONSE_ABORTED')));
        res.once('end', () => {
          try { resolve({statusCode:res.statusCode, body:JSON.parse(text)}); }
          catch { reject(new Error('SOCKET_BAD_JSON')); }
        });
      });
      req.once('error', reject);
      req.end(payload);
    });
    try {
      const result = await bounded(response);
      await bounded(closed);
      return result;
    } catch (error) {
      activeRequest?.destroy();
      activeSocket?.destroy();
      throw error;
    }
  }

  // This is a fallback only; the production shutdown must close its listener.
  async function cleanup() {
    activeRequest?.destroy();
    activeSocket?.destroy();
    if (server?.listening) await bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  }

  return Object.freeze({bind, attach, post, cleanup});
}


import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

const markers = ['synthetic-user-key-72941', 'sk-ant-api-synthetic-provider-key-72941', 'synthetic-provider-key-72941'];
if (process.argv[2] !== '--isolated') {
  async function run(mutant) {
    const outcome = await new Promise(resolve => {
      let child, closed=false, status, signal, timedOut=false, overflow=false, leaked=false, streamError=false, childError=false, setupError=false, out='', err='', timer, grace, finished=false, killRequested=false;
      const tails=['',''], streamClosed=[false,false], maxMarker=Math.max(...markers.map(x => x.length));
      const kill = () => { if (child && !closed && !killRequested) { killRequested=true; try { child.kill(); } catch { childError=true; } } };
      const done = () => { if (finished) return; finished=true; clearTimeout(timer); clearTimeout(grace); resolve({closed,streamClosed,status,signal,timedOut,overflow,leaked,streamError,childError,setupError,out,err,pid:child?.pid}); };
      const maybeDone = () => { if (closed && streamClosed.every(Boolean)) done(); };
      try {
        const scratch=process.env.TMPDIR;
        if (!scratch || !isAbsolute(scratch)) throw new Error('SCRATCH_REQUIRED');
        child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--isolated',...(mutant ? ['--mutant'] : [])],{env:{},cwd:scratch,stdio:['ignore','pipe','pipe']});
        child.on('error',()=>{childError=true;kill();});
        child.on('close',(code,sig)=>{closed=true;status=code;signal=sig;maybeDone();});
        for (const [stream,i] of [[child.stdout,0],[child.stderr,1]]) {
          stream.on('error',()=>{streamError=true;kill();});
          stream.on('close',()=>{streamClosed[i]=true;maybeDone();});
          stream.setEncoding('utf8');
          stream.on('data',chunk=>{
            const scan=tails[i]+chunk;
            if(markers.some(m=>scan.includes(m))) leaked=true;
            tails[i]=scan.slice(-(maxMarker-1));
            if(out.length+err.length+chunk.length>65536){overflow=true;kill();}
            else if(!overflow){if(i)err+=chunk;else out+=chunk;}
          });
        }
        timer=setTimeout(()=>{timedOut=true;kill();},12000);
        grace=setTimeout(()=>{if(!closed || !streamClosed.every(Boolean)){kill();child.stdout.destroy();child.stderr.destroy();child.unref();done();}},15000);
      } catch { setupError=true; if(!child)done(); else {kill(); if(!grace)grace=setTimeout(()=>{child.stdout?.destroy();child.stderr?.destroy();child.unref();done();},15000);maybeDone();} }
    });
    assert.equal(outcome.closed && outcome.streamClosed.every(Boolean),true,`owned child closure unconfirmed (pid ${outcome.pid ?? 'unknown'})`);
    assert.equal(!outcome.leaked && !outcome.timedOut && !outcome.overflow && !outcome.streamError && !outcome.childError && !outcome.setupError && outcome.signal===null,true,'child guard/closure failure');
    const categories=['SOCKET_BIND_GUARD','SOCKET_BIND_FAILED','STAGE_BIND_AFTER','STAGE_GUARDS','STAGE_DEPENDENCIES','STAGE_DATABASE','STAGE_BIND','STAGE_SCHEMA','STAGE_MODULES','STAGE_SERVER','STAGE_REQUEST','STAGE_WRITER','STAGE_HOOK','STAGE_MUTATION','STAGE_NORMAL','MUTATION_MISMATCH','TIMEOUT','SHUTDOWN_SETUP','SHUTDOWN_RESPONSE','SHUTDOWN_WRITER','SHUTDOWN_HOOKS','LISTENER_CLOSE','SHUTDOWN_ADMISSION','SHUTDOWN_MUTANT','SHUTDOWN_EARLY_CLOSE','SHUTDOWN_USAGE','SHUTDOWN_ORDER','CLEANUP_FAILURE','FIXTURE_FAILURE'];
    categories.push('STAGE_WAIT_DRAIN','STAGE_WAIT_SERVER','STAGE_SNAPSHOT','EARLY_DB_CLOSED','EARLY_ROW','EARLY_CLOSE_EVENT','EARLY_DEADLINE_UNREF','RESPONSE_STARTUP','RESPONSE_STATUS','RESPONSE_OBJECT','RESPONSE_MODEL','RESPONSE_CHOICES','RESPONSE_CONTENT','RESPONSE_FINISH','RESPONSE_UPSTREAM','RESPONSE_CREDENTIAL','RESPONSE_REFRESH');
    categories.push('STATUS_400','STATUS_401','STATUS_403','STATUS_429','STATUS_500','STATUS_502','STATUS_503','STATUS_OTHER');
    const category=categories.find(value=>outcome.out===`${value}\n` && outcome.err==='');
    assert.equal(outcome.status===0 && outcome.out===(mutant ? 'MUTANT_DRAIN_BYPASSED\n' : 'SOCKET_USAGE_OK\n') && outcome.err==='',true,category ? `fixture failed: ${category}` : 'fixture did not reach expected fixed outcome');
  }
  test('real loopback response retains post-response usage until shutdown drain', {timeout:45000}, async()=>{await run(false);await run(true);});
} else {
  let stage='STAGE_GUARDS';
  let socketHarness;
  try {
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const { EventEmitter } = await import('node:events');
    const vm = await import('node:vm');
    const require = createRequire(import.meta.url);
    // Install before loading any third-party package. IPC/stdio already exist;
    const denied = () => { throw new Error('HOST_NETWORK_DENIED'); };
    const http=require('node:http'), https=require('node:https'), tls=require('node:tls');
    const net=require('node:net'), dns=require('node:dns');
    socketHarness=makeOwnedLoopbackHarness(http,net);
    // Node's listen resolves even a numeric host through dns.lookup. Bind the
    // explicitly restricted harness listener before installing the deny guards.
    stage='STAGE_BIND';
    const port=await socketHarness.bind();
    stage='STAGE_GUARDS';
    globalThis.fetch=denied;
    http.request=http.get=https.request=https.get=tls.connect=denied;
    net.Socket.prototype.connect=net.Server.prototype.listen=denied;
    dns.lookup=dns.lookupService=dns.resolve=dns.reverse=denied;
    for(const key of Object.keys(dns)) if(key.startsWith('resolve') && typeof dns[key]==='function')dns[key]=denied;
    dns.promises.lookup=dns.promises.lookupService=dns.promises.resolve=dns.promises.reverse=denied;
    for(const key of Object.keys(dns.promises)) if(key.startsWith('resolve') && typeof dns.promises[key]==='function')dns.promises[key]=denied;
    syncBuiltinESMExports();
    for(const fn of [globalThis.fetch,http.request,http.get,https.request,https.get,tls.connect,net.Socket.prototype.connect,net.Server.prototype.listen,dns.lookup,dns.lookupService,dns.resolve,dns.reverse,dns.promises.lookup,dns.promises.lookupService,dns.promises.resolve,dns.promises.reverse]){
      let blocked=false;try{fn();}catch(error){blocked=error instanceof Error && error.message==='HOST_NETWORK_DENIED';}
      if(!blocked)throw new Error('HOST_GUARD_FAILURE');
    }
    stage='STAGE_DEPENDENCIES';
    const ts = require('typescript');
    const NativeDatabase = require('better-sqlite3');
    function Database(name, options) {
      if (name !== ':memory:' || options !== undefined) throw new Error('MEMORY_ONLY');
      return new NativeDatabase(':memory:');
    }
    const express = require('express');
    const crypto = require('node:crypto');

    stage='STAGE_DATABASE';
    const db = new Database(':memory:');
    let manager, primary='', cleanupFailed=false, releaseWriter, shutdownStarted=false, shutdownDone, context, fakeProcess, deadlineFired=false, actualDrain, server;
    const events=[];
    const shutdownTimers=new Set();
    let failedCheck='';
    const check=(value,category)=>{if(!value){failedCheck=category;throw new Error(category);}};
    const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TIMEOUT')),3000);})]);}finally{clearTimeout(timer);}};
    try {
      stage='STAGE_BIND_AFTER';
      let wall=Date.parse('2031-07-01T00:00:00.000Z'), monotonic=5000000000n;
      class FakeDate extends Date {constructor(...args){super(...(args.length?args:[wall]));}static now(){return wall;}}
      let startupLogged=false;
      const logger=Object.freeze({debug(){},info(_obj,message){if(message==='🚀 Multi-Account Router started')startupLogged=true;},warn(){},error(){}});
      const processShim=Object.freeze({env:Object.freeze(Object.create(null)),hrtime:Object.freeze({bigint:()=>monotonic})});
      let unknownCredential=false;
      const calls=[];
      const localFetch=async (_url,options)=>{
        if(options?.headers?.['x-api-key']!==markers[1]){unknownCredential=true;throw new Error('UNKNOWN_CREDENTIAL');}
        calls.push('A');
        const events=[
          {type:'message_start',message:{id:'synthetic',content:[],usage:{input_tokens:1}}},
          {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture answer'}},
          {type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
          {type:'message_stop'},
        ].map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
        return new Response(events,{status:200,headers:{'content-type':'text/event-stream'}});
      };
      context=vm.createContext({Date:FakeDate,process:processShim,console:Object.freeze({}),Promise,Buffer,AbortController,Response,TransformStream,TextDecoder,setTimeout,clearTimeout,fetch:localFetch});
      const read=path=>readFileSync(new URL(`../src/${path}.ts`,import.meta.url),'utf8');
      function load(path,dependencies={}){
        let input=read(path);
        if(path==='server'){
          const deadlineCall='shutdownDeadline = setTimeout(';
          check(input.split(deadlineCall).length===2,'SHUTDOWN_SETUP');
          input=input.replace(deadlineCall,'shutdownDeadline = __shutdownTimer(');
        }
        if(path==='server' && process.argv.includes('--mutant')){
          const expression='    requestDrain,\n';
          check(input.split(expression).length===2,'MUTATION_MISMATCH');
          input=input.replace(expression,'    Promise.resolve(true),\n');
        }
        const source=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
        const exports={}; const module={exports};
        new vm.Script(`(function(exports, require, module){${source}\n})`,{filename:`${path}.ts`}).runInContext(context)(exports,name=>{if(!Object.hasOwn(dependencies,name))throw new Error('UNEXPECTED_IMPORT');return dependencies[name];},module);
        return module.exports;
      }
      stage='STAGE_SCHEMA';
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
      db.pragma('foreign_keys = ON');
      const client = {getDb:() => db, requireInitializedDatabase:() => db};
      const env = {env:{ENCRYPTION_KEY:'00'.repeat(32), NODE_ENV:'test', HOST:'127.0.0.1', PORT:port}};
      stage='STAGE_MODULES';
      const encryption = load('utils/encryption', {crypto, '../config/env.js':env});
      const writer = load('db/async-writer', {'better-sqlite3':Database, './client.js':client, '../utils/logger.js':{logger}});
      const v2 = load('db/account-429-v2-store');
      writer.withAsyncWriter(connection => v2.provision429V2(connection));
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
      const forward = load('upstream/forward-chat', {crypto, events:require('node:events'), '../account-pool/manager.js':pool, '../db/repositories/usage-logs.js':usage, '../db/repositories/accounts.js':accounts, '../utils/logger.js':{logger}, './tokens.js':tokens, './inference.js':inference, './account-quota.js':quota, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/encryption.js':encryption, './siwc-store.js':siwcStore, './siwc-refresh.js':siwcRefresh, '../db/repositories/settings.js':settings, './ordinary-429-deadline.js':deadline});
      const auth = load('auth/user-auth', {'../db/repositories/users.js':users, '../utils/encryption.js':encryption, '../utils/logger.js':{logger}, '../config/env.js':env, '../db/async-writer.js':writer, '../request-work.js':{requestWork:manager}});
      const router = load('routes/v1', {express, '../config/env.js':env, '../auth/user-auth.js':auth, '../request-work.js':{requestWork:manager}, '../utils/logger.js':{logger}, '../upstream/forward-chat.js':forward}).default;
      const user = new users.UserRepository().create({apiKeyHash:encryption.hashApiKey(markers[0]),name:'fixture',email:'fixture@example.invalid',tier:'free',dailyLimit:10});
      const repo = new accounts.AccountRepository();
      const a = repo.create({name:'A',provider:'anthropic',credentialType:'api_key',credentials:markers[1],priority:0});

      let entered, closedResolve, listenerResolve;
      const writerEntered=new Promise(resolve=>{entered=resolve;});
      const writerGate=new Promise(resolve=>{releaseWriter=resolve;});
      shutdownDone=new Promise(resolve=>{closedResolve=resolve;});
      const listenerClosed=new Promise(resolve=>{listenerResolve=resolve;});
      const originalWriter=writer.withAsyncWriter, originalSuccess=pool.accountPool.recordSuccessAsync, originalCreate=usage.UsageLogRepository.prototype.create;
      let armed=false, successFinished=false, usageEntered=false, usageArgs, usageRow, writerError, snapshot;
      pool.accountPool.recordSuccessAsync=async function(...args){const value=await originalSuccess.apply(this,args);successFinished=true;armed=true;events.push('account-success-settled');return value;};
      usage.UsageLogRepository.prototype.create=function(...args){usageEntered=true;usageArgs=args;events.push('usage-create-entered');const value=originalCreate.apply(this,args);usageRow=value;events.push('usage-create-returned');return value;};
      writer.withAsyncWriter=(...args)=>{
        if(!armed)return originalWriter(...args);
        armed=false;events.push('writer-entered');entered();
        return writerGate.then(()=>{events.push('writer-released');try{return originalWriter(...args);}catch(error){writerError=error;events.push('writer-error');throw error;}});
      };
      const appFactory=Object.assign(()=>{
        const app=express();
        app.listen=(requestedPort,host,callback)=>{
          server=socketHarness.attach(app,requestedPort,host,callback);
          const originalClose=server.close;
          server.close=function(cb){events.push('listener-close');return originalClose.call(this,error=>{events.push('listener-closed');listenerResolve(error);cb?.(error);});};
          return server;
        };
        return app;
      },{json:express.json});
      fakeProcess=Object.assign(new EventEmitter(),{env:processShim.env,hrtime:processShim.hrtime,exitCode:0,exit:()=>{deadlineFired=true;}});
      const originalDrain=manager.stopAndDrain.bind(manager);
      manager.stopAndDrain=()=>{events.push('request-drain');actualDrain=originalDrain();return actualDrain;};
      const fakeClient={...client,initDatabase:()=>check(db.open,'SHUTDOWN_SETUP'),closeDatabase:()=>{
        snapshot=db.prepare('SELECT id,user_id,upstream_account_id,model,provider,input_tokens,output_tokens,usage_known,success FROM usage_logs').all();
        events.push('db-close');db.close();closedResolve();
      }};
      const stop=name=>()=>{events.push(name);return Promise.resolve().then(()=>events.push(`${name}-settled`));};
      class FakeExpiry{start(){events.push('expiry-start');}stopAndDrain(){return stop('expiry-stop')();}}
      context.process=fakeProcess;
      context.__shutdownTimer=(fn,delay,...args)=>{check(shutdownStarted && delay===5000,'SHUTDOWN_SETUP');const handle=setTimeout(()=>{shutdownTimers.delete(handle);fn(...args);},delay);const originalUnref=handle.unref.bind(handle);handle.unref=()=>{events.push('deadline-unref');closedResolve();return originalUnref();};shutdownTimers.add(handle);return handle;};
      context.clearTimeout=handle=>{shutdownTimers.delete(handle);clearTimeout(handle);};
      stage='STAGE_SERVER';
      load('server',{
        express:appFactory,'./config/env.js':env,'./utils/logger.js':{logger},
        './upstream/oauth.js':{stopOAuth:stop('oauth-stop')},
        './upstream/siwc-login.js':{stopSiwc:stop('siwc-stop'),noStoreSiwc:(_req,_res,next)=>next()},
        './upstream/tokens.js':{drainTokenRefreshes:stop('token-stop')},
        './request-work.js':{requestWork:manager,trackedErrorHandler:handler=>work.trackedErrorHandler(handler,manager)},
        './db/client.js':fakeClient,'./db/async-writer.js':{retryQuarantinedWriters:()=>events.push('writers-retried')},
        './db/account-429-v2-store.js':v2,'./db/account-429-v2-expiry.js':{Account429V2Expiry:FakeExpiry},
        './routes/v1.js':router,'./routes/admin.js':express.Router(),
      });
      // socketHarness queues the production listening callback in a microtask.
      // DB and scheduler startup now happen in that callback, not during load.
      await Promise.resolve();
      check(server?.listening && events.includes('expiry-start') && fakeProcess.listenerCount('SIGTERM')===1,'SHUTDOWN_SETUP');
      stage='STAGE_REQUEST';
      const result=await socketHarness.post({model:'claude-fixture',messages:[{role:'user',content:'hello'}]},`Bearer ${markers[0]}`);
      check(startupLogged,'RESPONSE_STARTUP');
      if(result.statusCode!==200){
        const statusCategory=({400:'STATUS_400',401:'STATUS_401',403:'STATUS_403',429:'STATUS_429',500:'STATUS_500',502:'STATUS_502',503:'STATUS_503'})[result.statusCode] ?? 'STATUS_OTHER';
        throw new Error(statusCategory);
      }
      check(result.body?.object==='chat.completion','RESPONSE_OBJECT');
      check(result.body?.model==='claude-fixture','RESPONSE_MODEL');
      check(result.body?.choices?.length===1,'RESPONSE_CHOICES');
      check(result.body.choices[0].message?.content==='fixture answer','RESPONSE_CONTENT');
      check(result.body.choices[0].finish_reason==='stop','RESPONSE_FINISH');
      check(calls.length===1,'RESPONSE_UPSTREAM');
      check(!unknownCredential,'RESPONSE_CREDENTIAL');
      check(refreshCalls===0,'RESPONSE_REFRESH');
      stage='STAGE_WRITER';
      await bounded(writerEntered);
      check(successFinished && !armed && !usageEntered && db.open && db.prepare('SELECT count(*) n FROM usage_logs').get().n===0,'SHUTDOWN_WRITER');
      stage='STAGE_HOOK';
      shutdownStarted=true;fakeProcess.emit('SIGTERM');
      check(actualDrain && events.includes('request-drain'),'SHUTDOWN_HOOKS');
      const closeError=await bounded(listenerClosed);
      check(!closeError && !server.listening,'LISTENER_CLOSE');
      await Promise.resolve();
      check(['token-stop-settled','expiry-stop-settled','oauth-stop-settled','siwc-stop-settled'].every(e=>events.includes(e)),'SHUTDOWN_HOOKS');
      events.push('other-drains-settled');
      check(manager.run(()=>{throw new Error('UNEXPECTED_ADMISSION');})===undefined,'SHUTDOWN_ADMISSION');
      if(process.argv.includes('--mutant')){
        stage='STAGE_MUTATION';
        await bounded(shutdownDone);
        check(db.open && !events.includes('db-close') && !usageEntered && events.includes('deadline-unref') && !events.includes('writer-released'),'SHUTDOWN_MUTANT');
        releaseWriter();await bounded(actualDrain);
        check(!writerError && usageEntered && usageRow && db.open && events.indexOf('deadline-unref')<events.indexOf('writer-released'),'SHUTDOWN_MUTANT');
        primary='MUTANT_DRAIN_BYPASSED';
      }else{
        stage='STAGE_NORMAL';
        check(db.open,'EARLY_DB_CLOSED');check(db.prepare('SELECT count(*) n FROM usage_logs').get().n===0,'EARLY_ROW');check(!events.includes('db-close'),'EARLY_CLOSE_EVENT');check(!events.includes('deadline-unref'),'EARLY_DEADLINE_UNREF');
        releaseWriter();stage='STAGE_WAIT_DRAIN';await bounded(actualDrain);stage='STAGE_WAIT_SERVER';await bounded(shutdownDone);stage='STAGE_SNAPSHOT';
        snapshot=db.prepare('SELECT id,user_id,upstream_account_id,model,provider,input_tokens,output_tokens,usage_known,success FROM usage_logs').all();
        check(!writerError && usageEntered && usageRow && usageArgs[1]===db && usageArgs[0].userId===user.id && usageArgs[0].upstreamAccountId===a.id && usageArgs[0].model==='claude-fixture' && usageArgs[0].provider==='anthropic' && usageArgs[0].inputTokens===1 && usageArgs[0].outputTokens===1 && usageArgs[0].success===true && db.open && snapshot.length===1 && snapshot[0].id===usageRow.id && snapshot[0].user_id===user.id && snapshot[0].upstream_account_id===a.id && snapshot[0].model==='claude-fixture' && snapshot[0].provider==='anthropic' && snapshot[0].input_tokens===1 && snapshot[0].output_tokens===1 && snapshot[0].usage_known===1 && snapshot[0].success===1,'SHUTDOWN_USAGE');
        const order=['account-success-settled','writer-entered','request-drain','listener-closed','other-drains-settled','writer-released','usage-create-entered','usage-create-returned','deadline-unref'].map(e=>events.indexOf(e));
        check(order.every((value,index)=>value>=0 && (!index || order[index-1]<value)),'SHUTDOWN_ORDER');
      }
    } catch(error) {
      const allowed=['SOCKET_BIND_GUARD','SOCKET_BIND_FAILED','MUTATION_MISMATCH','TIMEOUT','SHUTDOWN_SETUP','SHUTDOWN_RESPONSE','SHUTDOWN_WRITER','SHUTDOWN_HOOKS','LISTENER_CLOSE','SHUTDOWN_ADMISSION','SHUTDOWN_MUTANT','SHUTDOWN_EARLY_CLOSE','SHUTDOWN_USAGE','SHUTDOWN_ORDER'];
      allowed.push('EARLY_DB_CLOSED','EARLY_ROW','EARLY_CLOSE_EVENT','EARLY_DEADLINE_UNREF');
      allowed.push('RESPONSE_STARTUP','RESPONSE_STATUS','RESPONSE_OBJECT','RESPONSE_MODEL','RESPONSE_CHOICES','RESPONSE_CONTENT','RESPONSE_FINISH','RESPONSE_UPSTREAM','RESPONSE_CREDENTIAL','RESPONSE_REFRESH');
      allowed.push('STATUS_400','STATUS_401','STATUS_403','STATUS_429','STATUS_500','STATUS_502','STATUS_503','STATUS_OTHER');
      primary=allowed.includes(failedCheck)?failedCheck:error instanceof Error && allowed.includes(error.message)?error.message:stage;
    } finally {
      releaseWriter?.();
      if(manager){try{await bounded(manager.stopAndDrain());}catch{cleanupFailed=true;}}
      if(shutdownStarted){try{await bounded(shutdownDone);}catch{cleanupFailed=true;}}
      try{await socketHarness.cleanup();}catch{cleanupFailed=true;}
      if(deadlineFired || (fakeProcess && fakeProcess.exitCode!==0) || (shutdownStarted && !events.includes('deadline-unref')))cleanupFailed=true;
      for(const timer of shutdownTimers)clearTimeout(timer);
      if(!cleanupFailed && db.open){try{db.close();if(db.open)cleanupFailed=true;}catch{cleanupFailed=true;}}
    }
    if(cleanupFailed){process.stdout.write('CLEANUP_FAILURE\n');process.exitCode=1;}
    else if(primary && primary!=='MUTANT_DRAIN_BYPASSED'){process.stdout.write(`${primary}\n`);process.exitCode=1;}
    else process.stdout.write(primary ? 'MUTANT_DRAIN_BYPASSED\n' : 'SOCKET_USAGE_OK\n');
  } catch {
    try { await socketHarness?.cleanup(); }
    catch { stage='CLEANUP_FAILURE'; }
    process.stdout.write(`${stage}\n`);process.exitCode=1;
  }
}
