// Real Express dispatch with synthetic dependencies: no sockets or database.
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
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
function fixture(forward = async()=>{}) {
  const api=load('../src/request-work.ts'), manager=new api.RequestWorkManager(), logger={error(){},warn(){},debug(){}};
  const user={id:'u',name:'u',email:'u',tier:'free',dailyLimit:1};
  const auth=load('../src/auth/user-auth.ts',{'../db/repositories/users.js':{UserRepository:class {findByApiKeyHash(){return user}}},'../utils/encryption.js':{hashApiKey:()=> 'hash'},'../utils/logger.js':{logger},'../config/env.js':{env:{}},'../request-work.js':{requestWork:manager},'../db/async-writer.js':{withAsyncWriter:()=>({allowed:true,user})}});
  const router=load('../src/routes/v1.ts',{express,'../config/env.js':{env:{NODE_ENV:'test'}},'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../upstream/forward-chat.js':{forwardMessages:forward,forwardResponses:forward,anthropicErrorEnvelope(){},anthropicErrorBody:(_s,message)=>({type:'error',error:{type:'api_error',message}}),forwardChat:forward}}).default;
  return {api,manager,router};
}
function request(method='POST',url='/chat/completions',headers={}) {return {method,url,headers};}
function response(){return Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;this.writableEnded=true;return this},set(k,v){this[k]=v;return this},send(v){this.body=v;this.writableEnded=true;return this},destroy(){this.destroyed=true}});}
test('auth early response, dispatch-out, and automatic OPTIONS drain', {timeout:2000}, async()=>{
  for(const [req,status,body] of [[request(),401,undefined],[request('GET','/missing'),200,undefined],[request('OPTIONS','/models'),200,'GET,HEAD']]){
    const {manager,router}=fixture(),res=response(),out=deferred();
    router.handle(req,res,()=>out.resolve());
    await manager.stopAndDrain();
    assert.equal(res.statusCode,status); if(body) assert.equal(res.body,body);
  }
});
test('v1 error terminates locally and drains', {timeout:2000},async()=>{
  const {manager,router}=fixture(async()=>{throw 'route'}),res=response();let calls=0;
  const req=request('POST','/chat/completions',{authorization:'Bearer synthetic'});
  router.handle(req,res,()=>calls++);
  await manager.stopAndDrain();
  assert.equal(calls,0);assert.equal(res.statusCode,500);
  assert.deepEqual(res.body,{error:{type:'internal_error',message:'Internal server error.'}});
});
// ADR 0019: /messages and /responses are owned inference endpoints like /chat/completions.
test('all v1 routes execute their real authentication and drain', {timeout:2000}, async()=>{
  for (const [method,url,status] of [['POST','/chat/completions',200],['POST','/messages',200],['POST','/responses',200],['GET','/models',200]]) {
    let calls=0;
    const {manager,router}=fixture(async (_req,res)=>{calls++;res.json({ok:true})}), res=response();
    router.handle(request(method,url,{authorization:'Bearer synthetic'}),res,()=>{});
    await manager.stopAndDrain();
    assert.equal(res.statusCode,status);
    assert.equal(res.writableEnded,true);
    assert.equal(calls,url==='/models'?0:1);
  }
});
