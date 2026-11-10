// Real Express router with synthetic request/response; no sockets or database.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript'), express = require('express');
function load(path, deps = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, name => name === 'node:async_hooks' ? require(name) : name in deps ? deps[name] : (()=>{throw Error('unexpected dependency')})());
  return exports;
}
function deferred(){ let resolve; const promise = new Promise(r=>{resolve=r}); return {promise,resolve}; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject)=>{timer=setTimeout(()=>reject(Error('barrier deadline')),1000)})]); }
  finally { clearTimeout(timer); }
}
test('v1 dispatch remains owned while unrelated inherited work cannot claim it', {timeout:2000}, async () => {
  const {RequestWorkManager} = load('../src/request-work.ts');
  const manager = new RequestWorkManager(), authGate = deferred(), entered = deferred(), finish = deferred(), foreign = deferred(), attempt = deferred();
  let unrelated, control = false, foreignRan = false;
  const logger = {error(){},warn(){},debug(){}};
  const user = {id:'u',name:'u',email:'u',tier:'free',dailyLimit:10};
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js':{UserRepository:class {}}, '../utils/encryption.js':{hashApiKey:()=> 'hash'},
    '../utils/logger.js':{logger}, '../config/env.js':{env:{}}, '../request-work.js':{requestWork:manager},
    '../db/async-writer.js':{withAsyncWriter:()=> authGate.promise.then(()=>({allowed:true,user}))}
  });
  const routes = load('../src/routes/v1.ts', {express, '../config/env.js':{env:{NODE_ENV:'test'}}, '../auth/user-auth.js':auth, '../request-work.js':{requestWork:manager}, '../utils/logger.js':{logger}, '../upstream/forward-chat.js':{forwardChat:async (_req,res)=>{
    const positive = manager.runDispatch(()=>{control=true});
    await positive;
    setImmediate(async()=>{await attempt.promise; unrelated=manager.runDispatch(()=>{foreignRan=true}); foreign.resolve();});
    res.writableEnded=true; entered.resolve(); await finish.promise;
  }}}).default;
  const req = {method:'POST',url:'/chat/completions',headers:{authorization:'Bearer synthetic'}};
  const res = Object.assign(new EventEmitter(), {destroyed:false,writableEnded:false,headersSent:false,status(){return this},json(){this.writableEnded=true;return this},destroy(){this.destroyed=true}});
  routes.handle(req,res,()=>{});
  authGate.resolve();
  let drained = false, drain;
  try {
    await bounded(entered.promise);
    assert.equal(control,true, 'dispatch positive control executes before stop');
    assert.deepEqual(req.user,user, 'real authentication precedes the real endpoint');
    drain = manager.stopAndDrain().then(()=>{drained=true});
    attempt.resolve();
    await bounded(foreign.promise);
    assert.equal(unrelated,undefined, 'inherited context cannot claim dispatch');
    assert.equal(foreignRan,false);
    assert.equal(drained,false);
  } finally { authGate.resolve(); attempt.resolve(); finish.resolve(); if (unrelated) await bounded(unrelated); if (drain) await bounded(drain); }
});
