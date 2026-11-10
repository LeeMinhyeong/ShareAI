// Transpiled production entrypoints; all dependencies are synthetic, no sockets or files.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url), ts=require('typescript');
const compile=p=>ts.transpileModule(readFileSync(new URL(p,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(code,deps,globals={}) {
  const exports={};
  vm.runInThisContext(`(function(exports,require,process,setTimeout,clearTimeout){${code}\n})`)(exports,n=>{if (!(n in deps)) throw Error(`unexpected ${n}`);return deps[n]},globals.process??process,globals.setTimeout??setTimeout,globals.clearTimeout??clearTimeout);
  return exports;
}
test('initialization failure fences admission and retains database until deadline',()=>{
  let listens=0,dbClosed=0,deadline,exited,startup,initCalls=0; const events=[];
  const app={all(){},use(){},get(){},listen(_port,_host,cb){listens++;startup=cb;return {on(){},close(){events.push('listener-close')},closeAllConnections(){}}}};
  const express=Object.assign(()=>app,{json:()=>()=>{}});
  const processFake={exitCode:0,on(){},exit(code){exited=code}};
  const logger={info(){},error(message){events.push(message)}};
  const deps={'express':{default:express},'./config/env.js':{env:{}},'./utils/logger.js':{logger},'./upstream/oauth.js':{stopOAuth(){}},'./upstream/siwc-login.js':{stopSiwc(){},noStoreSiwc(){}},'./upstream/tokens.js':{drainTokenRefreshes(){events.push('tokens')}},'./db/client.js':{initDatabase(){initCalls++;throw Error('synthetic init')},requireInitializedDatabase(){},closeDatabase(){dbClosed++}},'./db/account-429-v2-store.js':{assert429V2Schema(){}},'./db/account-429-v2-expiry.js':{Account429V2Expiry:class {}},'./routes/v1.js':{default:{}},'./routes/admin.js':{default:{}},'./request-work.js':{trackedErrorHandler: handler => handler,requestWork:{stopAndDrain(){events.push('requests')}}}};
  load(compile('../src/server.ts'),deps,{process:processFake,setTimeout(fn,ms){assert.equal(ms,5000);events.push('timer');deadline=fn;return {unref(){throw Error('unexpected unref')}}},clearTimeout(){throw Error('unexpected clear')}});
  assert.equal(listens,1); assert.equal(initCalls,0); assert.deepEqual(events,[]); assert.equal(typeof startup,'function');
  startup();
  assert.equal(initCalls,1);
  assert.deepEqual(events,['timer','requests','tokens','listener-close','Server startup failed']);
  assert.equal(dbClosed,0); assert.equal(processFake.exitCode,1);
  deadline();assert.equal(exited,1);assert.equal(dbClosed,0);
});
test('migration retains both initialization and cleanup failures',()=>{
  const init=Error('init'), close=Error('close'); let result;
  try {load(compile('../src/db/migrate.ts'),{'./client.js':{initDatabase(){throw init},closeDatabase(){throw close}}})} catch(e) {result=e}
  assert.ok(result instanceof AggregateError); assert.deepEqual(result.errors,[init,close]);
});
test('successful drain retains quarantined writers and arms unreferenced deadline',async()=>{
  let startup, onSignal, onClosed, deadline, retryCalls=0, dbClosed=0, cleared=0, exited=0, notifyUnref; const logs=[];
  const unrefObserved=new Promise(resolve=>{notifyUnref=resolve});
  const server={on(){},close(cb){onClosed=cb},closeAllConnections(){}};
  const app={all(){},use(){},get(){},listen(_port,_host,cb){startup=cb;return server}};
  const express=Object.assign(()=>app,{json:()=>()=>{}});
  const processFake={exitCode:0,on(_signal,cb){onSignal=cb},exit(code){exited=code}};
  const logger={info(){},error(...args){logs.push(args)}};
  const deps={'express':{default:express},'./config/env.js':{env:{}},'./utils/logger.js':{logger},'./upstream/oauth.js':{stopOAuth:async()=>{}},'./upstream/siwc-login.js':{stopSiwc:async()=>{},noStoreSiwc(){}},'./upstream/tokens.js':{drainTokenRefreshes:async()=>{}},'./db/client.js':{initDatabase(){},requireInitializedDatabase(){},closeDatabase(){dbClosed++}},'./db/account-429-v2-store.js':{assert429V2Schema(){}},'./db/account-429-v2-expiry.js':{Account429V2Expiry:class {start(){}stopAndDrain(){return Promise.resolve()}}},'./db/async-writer.js':{retryQuarantinedWriters(){retryCalls++;throw Error('synthetic-secret')}},'./routes/v1.js':{default:{}},'./routes/admin.js':{default:{}},'./request-work.js':{trackedErrorHandler: handler => handler,requestWork:{stopAndDrain:async()=>{}}}};
  load(compile('../src/server.ts'),deps,{process:processFake,setTimeout(fn,ms){assert.equal(ms,5000);deadline=fn;return {unref(){notifyUnref()}}},clearTimeout(){cleared++}});
  startup(); onSignal(); assert.equal(retryCalls,0); onClosed();
  let timer;
  try { await Promise.race([unrefObserved,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('drain observation timed out')),1000)})]); }
  finally { clearTimeout(timer); }
  assert.equal(retryCalls,0); assert.equal(dbClosed,0); assert.equal(processFake.exitCode,0); assert.equal(cleared,0);
  deadline(); assert.equal(exited,1); assert.equal(dbClosed,0);
  assert.equal(logs.length===1 && logs[0].length===1 && logs[0][0]==='Shutdown deadline exceeded; terminating remaining work',true,'unexpected shutdown logs');
});
