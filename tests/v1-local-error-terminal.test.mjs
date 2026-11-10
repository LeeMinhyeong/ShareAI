// Real Express route, synthetic dependencies and response; no native sockets or services.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require=createRequire(import.meta.url), ts=require('typescript'), express=require('express');
function load(path,deps={}) {
 const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const out={}; vm.runInThisContext(`(function(exports,require){${code}\n})`)(out,n=>{if(n==='node:async_hooks') return require(n); if(!Object.hasOwn(deps,n)) throw Error('unexpected dependency');return deps[n]}); return out;
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture deadline')),500)})]);}finally{clearTimeout(timer)}}
function fixture(mode='test') {
 const {RequestWorkManager}=load('../src/request-work.ts'),manager=new RequestWorkManager(),gate=deferred(),entered=deferred(),logs=[];
 const logger={error(...args){logs.push(args)},warn(){},debug(){}};
 const router=load('../src/routes/v1.ts',{express,'../config/env.js':{env:{NODE_ENV:mode}},'../auth/user-auth.js':{authenticateUserInDispatch:(_req,_res,callback)=>callback()},'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../upstream/forward-chat.js':{forwardChat:(_req,res)=>{entered.resolve();return gate.promise.then(()=>res.json({ok:true}))}}}).default;
 const endpoint=router.stack.find(layer=>layer.route?.path==='/chat/completions').route.stack[0].handle;
 const req={method:'POST',url:'/chat/completions',path:'/chat/completions',headers:{}};
 const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,status(code){this.statusCode=code;return this},json(body){this.body=body;this.writableEnded=true;return this},destroy(){this.destroyed=true}});
 return {manager,gate,entered,endpoint,req,res,logs};
}
test('owned error never calls a throwing next and drains after local terminal',async()=>{
 const f=fixture(),secret='synthetic-secret-marker';let nextCalls=0,drained=false,terminalObserved=false;
 const json=f.res.json;f.res.json=function(body){assert.equal(drained,false);terminalObserved=true;return json.call(this,body)};
 f.endpoint(f.req,f.res,()=>{nextCalls++;throw Error('synthetic next failure')});
 await bounded(f.entered.promise);const drain=f.manager.stopAndDrain().then(()=>{drained=true});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 f.gate.reject(Error(secret));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nextCalls,0,'owned errors must not enter Express next');
 await bounded(drain);assert.equal(terminalObserved,true);assert.equal(f.res.statusCode,500);assert.deepEqual(f.res.body,{error:{type:'internal_error',message:'Internal server error.'}});
 assert.equal(JSON.stringify([f.res.body,f.logs]).includes(secret),false);
});
test('schedule-then-throw next is not invoked or scheduled',async()=>{
 const f=fixture('production');let calls=0,scheduled=0;
 assert.equal(f.endpoint(f.req,f.res,()=>{calls++;setImmediate(()=>scheduled++);throw Error('next');}),undefined);
 await bounded(f.entered.promise);const drain=f.manager.stopAndDrain();f.gate.reject('synthetic-secret');
 await bounded(drain);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,0);assert.equal(scheduled,0);
 assert.equal(f.res.statusCode,500);assert.deepEqual(f.res.body,{error:{type:'internal_error',message:'Internal server error'}});
});
test('successful endpoint settles before owned drain and retains success status',async()=>{
 const f=fixture();let calls=0,drained=false;
 assert.equal(f.endpoint(f.req,f.res,()=>calls++),undefined);await bounded(f.entered.promise);
 const drain=f.manager.stopAndDrain().then(()=>{drained=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 f.gate.resolve();await bounded(drain);assert.equal(calls,0);assert.equal(f.res.statusCode,200);assert.deepEqual(f.res.body,{ok:true});
});
test('falsey values and revoked proxy are normalized without leaking data',async()=>{
 const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const value of [undefined,null,false,0,'',revoked.proxy,Error('synthetic-secret-marker')]) {
  for(const mode of ['production','development','test']) {
   const f=fixture(mode);let calls=0;f.endpoint(f.req,f.res,()=>calls++);await bounded(f.entered.promise);
   const drain=f.manager.stopAndDrain();f.gate.reject(value);await bounded(drain);
   assert.equal(calls,0);assert.equal(f.res.statusCode,500);
   assert.deepEqual(f.res.body,{error:{type:'internal_error',message:mode==='production'?'Internal server error':'Internal server error.'}});
   assert.equal(f.logs.length,1);const [entry,message]=f.logs[0];
   assert.equal(message,'Unhandled error');assert.equal(entry.path,f.req.path);assert.equal(entry.method,f.req.method);
   assert.equal(entry.err.message,'Internal server error.');assert.equal(String(entry.err.stack).includes('synthetic-secret-marker'),false);
   assert.equal(JSON.stringify([entry,f.res.body]).includes('synthetic-secret-marker'),false);
  }
 }
});
test('headers sent, lost response, and terminal write failure destroy and drain',async()=>{
 for(const state of ['headers','lost','write']) {
  const f=fixture();let calls=0,destroys=0;f.res.destroy=function(){destroys++;this.destroyed=true};
  f.endpoint(f.req,f.res,()=>calls++);await bounded(f.entered.promise);const drain=f.manager.stopAndDrain();
  if(state==='headers') f.res.headersSent=true;
  if(state==='lost') f.res.destroyed=true;
  if(state==='write') f.res.json=()=>{throw Error('synthetic-secret-marker')};
  f.gate.reject(Error('synthetic-secret-marker'));await bounded(drain);
  assert.equal(calls,0);assert.equal(destroys,1);assert.equal(f.res.destroyed,true);assert.equal(f.res.body,undefined);
 }
});
