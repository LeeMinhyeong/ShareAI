// Production v1 router over real Express, with synthetic dependencies and no sockets.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require=createRequire(import.meta.url), ts=require('typescript'), express=require('express');
function load(path,deps={}) { const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText; const out={}; vm.runInThisContext(`(function(exports,require){${code}\n})`)(out,n=>{ if(n==='node:async_hooks') return require(n); if (!(n in deps)) throw Error(`unexpected dependency: ${n}`); return deps[n]; }); return out; }
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function bounded(p){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('barrier timed out')),300)})]).finally(()=>clearTimeout(timer));}
function response(){return Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;this.writableEnded=true;return this},destroy(){this.destroyed=true}})}
test('v1 admitted error terminates locally after stop',async()=>{
 const api=load('../src/request-work.ts'),manager=new api.RequestWorkManager(),forward=deferred();
 const logger={error(){},warn(){},debug(){}}; const auth={authenticateUserInDispatch:(_q,_r,n)=>n()};
 const router=load('../src/routes/v1.ts',{express,'../config/env.js':{env:{NODE_ENV:'test'}},'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../upstream/forward-chat.js':{forwardChat:()=>forward.promise}}).default;
 const req={method:'POST',url:'/chat/completions',headers:{}},res=response(),bad=response();let seen=0,drained=false;
 router.handle(req,res,()=>seen++);
 const drain=manager.stopAndDrain().then(()=>{drained=true});
 api.trackedErrorHandler(()=>assert.fail('unrelated claimed root'),manager)(Error('unrelated'),req,bad,()=>{});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);assert.equal(bad.statusCode,503);
 forward.reject(Error('synthetic'));await bounded(drain);
 assert.equal(seen,0);assert.deepEqual(res.body,{error:{type:'internal_error',message:'Internal server error.'}});
});
