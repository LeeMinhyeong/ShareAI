// Real Express router and authentication, with synthetic dependencies; no sockets or storage.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require=createRequire(import.meta.url), ts=require('typescript'), express=require('express');
function load(path,deps={}) {
 const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const out={}; vm.runInThisContext(`(function(exports,require){${code}\n})`)(out,n=>{if(n==='node:async_hooks')return require(n);if(!Object.hasOwn(deps,n))throw Error(`unexpected import ${n}`);return deps[n]}); return out;
}
function response(){return Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false,statusCode:200,status(n){this.statusCode=n;return this},json(v){this.body=v;this.headersSent=true;this.writableEnded=true;return this},destroy(){this.destroyed=true}})}
function fixture(forward,logger={error(){},warn(){},debug(){}},nodeEnv='test'){
 const api=load('../src/request-work.ts'),manager=new api.RequestWorkManager();
 const user={id:'u',name:'u',email:'u',tier:'free',dailyLimit:1};
 const auth=load('../src/auth/user-auth.ts',{'../db/repositories/users.js':{UserRepository:class{}},'../utils/encryption.js':{hashApiKey:()=> 'hash'},'../utils/logger.js':{logger},'../config/env.js':{env:{}},'../request-work.js':{requestWork:manager},'../db/async-writer.js':{withAsyncWriter:()=>({allowed:true,user})}});
 const router=load('../src/routes/v1.ts',{express,'../config/env.js':{env:{NODE_ENV:nodeEnv}},'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../upstream/forward-chat.js':{forwardChat:forward}}).default;
 return {api,manager,router};
}
test('revoked proxy and secret reach the production local terminal safely', {timeout:2000},async()=>{
 const {proxy,revoke}=Proxy.revocable({},{});revoke();
 for (const thrown of [proxy,Error('synthetic-secret')]) {
 const logs=[]; const logger={error(...args){logs.push(args)},warn(){},debug(){}};
 const {manager,router}=fixture(async()=>{throw thrown},logger);
 const req={method:'POST',url:'/chat/completions',headers:{authorization:'Bearer synthetic'}},res=response();let delivered,seen;
 router.handle(req,res,e=>{delivered=e;seen=true});
 await new Promise(resolve=>setImmediate(resolve));
 await manager.stopAndDrain();
 assert.equal(delivered,undefined); assert.equal(seen,undefined);
 assert.equal(res.statusCode,500);
 assert.equal(res.body.error.message==='Internal server error.',true,'generic response');
 assert.equal(logs.length,1);
 assert.equal(logs[0][0].err.message==='Internal server error.',true,'normalized log');
 assert.equal(JSON.stringify([res.body,logs]).includes('synthetic-secret'),false);
 }
});
test('shared wrapper is a bearer capability: first claimant wins', {timeout:2000},async()=>{
 const api=load('../src/request-work.ts'),manager=new api.RequestWorkManager(),req={},bad=response(),good=response();let wrapper,stolen=0,legitimate=0;
 manager.ownedDispatch(scope=>scope.forwardError(Error('synthetic'),value=>{wrapper=value}));
 const drain=manager.stopAndDrain();
 const imposter=api.trackedErrorHandler(()=>{stolen++},manager);
 const genuine=api.trackedErrorHandler(()=>{legitimate++},manager);
 imposter(wrapper,req,bad,()=>{}); genuine(wrapper,req,good,()=>{});
 await drain;
 // This API cannot distinguish holders of the same wrapper. Production v1
 // does not expose that wrapper: it uses the local terminal tested above.
 assert.equal(stolen,1);
 assert.equal(legitimate,0);
});

// A pre-auth unrelated invocation must not consume the router's admission.
test('unrelated authentication cannot steal the production router scope', {timeout:2000},async()=>{
 const api=load('../src/request-work.ts'),manager=new api.RequestWorkManager(),logger={error(){},warn(){},debug(){}};
 const user={id:'u',name:'u',email:'u',tier:'free',dailyLimit:1};
 const auth=load('../src/auth/user-auth.ts',{'../db/repositories/users.js':{UserRepository:class{}},'../utils/encryption.js':{hashApiKey:()=> 'hash'},'../utils/logger.js':{logger},'../config/env.js':{env:{}},'../request-work.js':{requestWork:manager},'../db/async-writer.js':{withAsyncWriter:()=>({allowed:true,user})}});
 let entered=false,drain;
 const router=load('../src/routes/v1.ts',{express,'../config/env.js':{env:{NODE_ENV:'test'}},'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../upstream/forward-chat.js':{forwardChat:async()=>{entered=true}}}).default;
 const stack=router.stack.find(x=>x.route?.path==='/chat/completions').route.stack;
 const extra=express.Router();
 extra.use((_req,_res,next)=>{void auth.authenticateUser({headers:{}},response(),()=>{throw Error('unexpected continuation')});next();});
 stack.splice(0,0,...extra.stack);
 const req={method:'POST',url:'/chat/completions',headers:{authorization:'Bearer synthetic'}},res=response();
 router.handle(req,res,()=>{});
 drain=manager.stopAndDrain();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(entered,true,'only actual route endpoint receives the scope');
 await drain;
});

test('completed response then rejection retains ownership and preserves keepalive', {timeout:2000},async()=>{
 let reject,entered=false,drained=false;
 const gate=new Promise((_,r)=>{reject=r});
 const logs=[];const logger={error(...a){logs.push(a)},warn(){},debug(){}};
 const {manager,router}=fixture(async(_req,res)=>{entered=true;res.json({ok:true});await gate},logger);
 const req={method:'POST',url:'/chat/completions',headers:{authorization:'Bearer synthetic',connection:'keep-alive'}},res=response();
 router.handle(req,res,()=>{throw Error('unexpected outer dispatch')});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);assert.equal(res.body?.ok===true,true,'successful response');
 const drain=manager.stopAndDrain().then(()=>{drained=true});
 await Promise.resolve();assert.equal(drained,false);
 reject(Error('synthetic-secret'));await drain;
 assert.equal(res.destroyed,false);assert.equal(res.body?.ok===true,true,'successful response retained');
 assert.equal(logs.length,1);assert.equal(JSON.stringify(logs).includes('synthetic-secret'),false);
});

test('pending response is destroyed on failure and production errors remain generic', {timeout:2000},async()=>{
 for(const pending of [false,true]) {
  const logger={error(){},warn(){},debug(){}};
  const {manager,router}=fixture(async(_req,res)=>{if(pending)res.headersSent=true;throw Error('synthetic-secret')},logger,'production');
  const res=response(),req={method:'POST',url:'/chat/completions',headers:{authorization:'Bearer synthetic'}};
  router.handle(req,res,()=>{}); await manager.stopAndDrain();
  assert.equal(res.destroyed===pending,true,'pending response disposition');
  if(!pending) assert.equal(res.body?.error?.message==='Internal server error',true,'production generic message');
 }
});

test('throwing error logger cannot leak or strand an owned failure', {timeout:2000},async()=>{
 let called=0;const logger={error(){called++;throw Error('logger synthetic-secret')},warn(){},debug(){}};
 const {manager,router}=fixture(async()=>{throw Error('provider synthetic-secret')},logger);
 const req={method:'POST',url:'/chat/completions',headers:{authorization:'Bearer synthetic'}},res=response();let outer=0;
 router.handle(req,res,()=>{outer++});await manager.stopAndDrain();
 assert.equal(called,1);assert.equal(outer,0);assert.equal(res.statusCode,500);
 assert.equal(res.body.error.message==='Internal server error.',true,'generic response');
 assert.equal(JSON.stringify(res.body).includes('synthetic-secret'),false);
});
