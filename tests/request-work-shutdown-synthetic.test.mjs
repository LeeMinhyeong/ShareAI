// Synthetic production entrypoint/auth/router; no network or database is opened.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(path, deps, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require,process,setTimeout,clearTimeout){${code}\n})`)(exports, name => {
    if (name === 'node:async_hooks') return require(name);
    if (!(name in deps)) throw new Error(`unexpected import: ${name}`);
    return deps[name];
  }, globals.process ?? process, globals.setTimeout ?? setTimeout, globals.clearTimeout ?? clearTimeout);
  return exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
async function bounded(promise) {let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture timed out')),2000);})]);}finally{clearTimeout(timer);}}
test('shutdown waits for owned authentication after disconnect and retains DB', async () => {
  const authGate = deferred(), unref = deferred(); let dbClosed = 0, retried = 0, forwards = 0, authSignal, startup, signal, closed, route, authStarted = false, serverDrain, stopCalls=0;
  const user = {id:'synthetic',name:'synthetic',email:'synthetic',tier:'free',dailyLimit:2};
  const logger = {info(){},error(){},warn(){},debug(){}};
  const work = load('../src/request-work.ts', {});
  const stop = work.requestWork.stopAndDrain.bind(work.requestWork);
  work.requestWork.stopAndDrain = () => {stopCalls++;serverDrain=stop();return serverDrain;};
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js':{UserRepository:class {}}, '../utils/encryption.js':{hashApiKey:()=> 'hash'},
    '../utils/logger.js':{logger}, '../config/env.js':{env:{}}, '../db/async-writer.js':{withAsyncWriter:(_fn,options)=>{authStarted=true;authSignal=options.signal;return authGate.promise}}, '../request-work.js':work
  });
  const router = {handle(){},post(path,...handlers){if(path==='/chat/completions') route=handlers},get(){}};
  load('../src/routes/v1.ts', {'express':{Router:()=>router},'../auth/user-auth.js':auth,'../request-work.js':work,'../utils/logger.js':{logger},'../config/env.js':{env:{}},'../upstream/forward-chat.js':{forwardChat(){forwards++;throw Error('disconnected request reached route')}}});
  const server={on(){},close(cb){closed=cb},closeAllConnections(){}};
  const middleware=[];
  const app={all(){},use(...args){middleware.push(args)},get(){},listen(_port,_host,cb){startup=cb;return server}};
  const express=Object.assign(()=>app,{json:()=> (_req,_res,next)=>next()});
  const processFake={exitCode:0,on(name,cb){if(name==='SIGTERM') signal=cb},exit(){throw Error('unexpected exit')}};
  load('../src/server.ts', {'express':{default:express},'./http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js':{env:{}},'./utils/logger.js':{logger},
    './upstream/oauth.js':{stopOAuth:async()=>{}},'./upstream/siwc-login.js':{stopSiwc:async()=>{},noStoreSiwc(){}},
    './upstream/tokens.js':{drainTokenRefreshes:async()=>{}},'./db/client.js':{initDatabase(){},requireInitializedDatabase(){},closeDatabase(){dbClosed++}},
    './db/account-429-v2-store.js':{assert429V2Schema(){}},'./db/account-429-v2-expiry.js':{Account429V2Expiry:class{start(){} stopAndDrain(){return Promise.resolve()}}},
    './db/async-writer.js':{retryQuarantinedWriters(){retried++}},'./routes/v1.js':{default:router},'./routes/admin.js':{default:{}}, './request-work.js':work
  },{process:processFake,setTimeout:(_fn,delay)=>{assert.equal(delay,5000);return {unref(){unref.resolve()}}},clearTimeout(){throw Error('unexpected deadline clear')}});
  startup();
  const res = Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false});
  const req = {headers:{authorization:'Bearer synthetic'},method:'POST',url:'/v1/chat/completions',path:'/v1/chat/completions'};
  const chain = middleware.flatMap(args => args.length === 1 ? args : args[0] === '/v1' ? route : []);
  let index=0;
  function next(error) { if (error) throw error; const handler=chain[index++]; if (handler) handler(req,res,next); }
  try {
    next();
    await Promise.resolve(); // Enter tracked authentication before disconnect.
    assert.equal(authStarted,true);
    res.destroyed=true; res.emit('close');assert.equal(authSignal.aborted,true);
    signal(); assert.equal(stopCalls,1); assert.ok(serverDrain); closed();
    const drain=serverDrain; let drained=false, unrefed=false;
    void drain.then(()=>{drained=true}); void unref.promise.then(()=>{unrefed=true});
    await bounded(new Promise(setImmediate));
    assert.equal(drained,false);assert.equal(unrefed,false);assert.equal(dbClosed,0);
    authGate.resolve({allowed:true,user});
    await bounded(drain);await bounded(unref.promise);await bounded(new Promise(setImmediate));
    assert.equal(dbClosed,0);assert.equal(retried,0);assert.equal(forwards,0);assert.equal(processFake.exitCode,0);
  } finally {
    authGate.resolve({allowed:true,user});
    await bounded(serverDrain ?? stop());
  }
});
