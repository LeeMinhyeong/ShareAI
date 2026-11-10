// Focused continuation and rejection checks; synthetic modules only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(path,deps={}){const s=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const out={};vm.runInThisContext(`(function(exports,require){${s}\n})`)(out,n=>{if(n==='node:async_hooks')return require(n);if(!(n in deps))throw Error(n);return deps[n]});return out}
const express=require('express');
const work=load('../src/request-work.ts');
function bounded(p,label){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),1000)})]).finally(()=>clearTimeout(timer))}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function response(sent=false){return {headersSent:sent,writableEnded:false,destroyed:false,statusCode:undefined,body:undefined,status(n){this.statusCode=n;return this},json(v){this.body=v;this.headersSent=true;this.writableEnded=true;return this},destroy(){this.destroyed=true}}}
const user={id:'u',name:'n',email:'e',tier:'free',dailyLimit:1},writerDb={};
function authFixture(manager,mode,logs){
  const counts={hash:0,lookup:0,writer:0,reserve:0,forward:0};
  const logger={error(...a){logs.push(a)},warn(...a){logs.push(a)},debug(...a){logs.push(a)}};
  const auth=load('../src/auth/user-auth.ts',{
    '../db/repositories/users.js':{UserRepository:class{
      findByApiKeyHash(hash){counts.lookup++;return hash==='valid-hash'?user:undefined}
      reserveDailyQuota(hash,_date,db){counts.reserve++;if(db!==writerDb)throw Error('unexpected writer');return hash==='valid-hash'?{user,allowed:mode!=='quota',used:1}:{user:undefined,allowed:false,used:0}}
    }},
    '../utils/encryption.js':{hashApiKey(key){counts.hash++;if(mode==='hash-fail')throw Error('synthetic-auth-marker');return key==='valid-key'?'valid-hash':'invalid-hash'}},
    '../utils/logger.js':{logger},'../config/env.js':{env:{}},
    '../db/async-writer.js':{withAsyncWriter(fn){counts.writer++;return Promise.resolve(fn(writerDb))}},
    '../request-work.js':{requestWork:manager},
  });
  return {auth,counts,logger};
}
function fixture(forward,environment='test',mode='valid'){
  const manager=new work.RequestWorkManager(),logs=[];
  const {auth,counts,logger}=authFixture(manager,mode,logs);
  const router=load('../src/routes/v1.ts',{'express':express,'../auth/user-auth.js':auth,'../upstream/forward-chat.js':{forwardChat(req,res){counts.forward++;return forward(req,res)}},'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../config/env.js':{env:{NODE_ENV:environment}}}).default;
  return {manager,router,logs,counts};
}
async function dispatch(f,res,next=()=>{throw Error('unexpected next')},headers={'x-api-key':'valid-key'}){f.router.handle({path:'/chat/completions',url:'/chat/completions',method:'POST',headers},res,next);await bounded(f.manager.stopAndDrain(),'route drain timeout')}

// This error middleware is synthetic; it is not the production server stack.
test('synthetic Express tracked error middleware retains asynchronous work until gate settles',async()=>{
  const manager=new work.RequestWorkManager(),gate=deferred(),entered=deferred();let calls=0,drained=false;
  const router=express.Router();
  router.get('/fail',(_req,_res,next)=>next(Error('fixture failure')));
  router.use(work.trackedErrorHandler(async()=>{calls++;entered.resolve();await gate.promise},manager));
  try{
    router.handle({method:'GET',url:'/fail',headers:{}},response(),()=>{throw Error('unexpected router exit')});
    await bounded(entered.promise,'middleware entry timeout');
    const done=manager.stopAndDrain().then(()=>{drained=true});
    await Promise.resolve();assert.equal(calls,1);assert.equal(drained,false);
    gate.resolve();await bounded(done,'middleware drain timeout');assert.equal(drained,true);
  }finally{gate.resolve()}
});

test('v1 real auth and Express dispatch enforce key and quota before forwarding',async()=>{
  for(const scenario of [
    {mode:'valid',headers:{},status:401,counts:[0,0,0,0,0]},
    {mode:'valid',headers:{'x-api-key':'invalid-key'},status:401,counts:[1,0,1,1,0]},
    {mode:'quota',headers:{'x-api-key':'valid-key'},status:429,counts:[1,0,1,1,0]},
    {mode:'valid',headers:{authorization:'Bearer valid-key'},status:200,counts:[1,0,1,1,1]},
  ]){
    let seenUser;
    const f=fixture((req,res)=>{seenUser=req.user;res.status(200).json({ok:true})},'test',scenario.mode),res=response();
    await dispatch(f,res,()=>{throw Error('unexpected router exit')},scenario.headers);
    assert.equal(res.statusCode,scenario.status);assert.equal(res.writableEnded,true);
    assert.deepEqual(Object.values(f.counts),scenario.counts);
    if(scenario.status===200){assert.equal(seenUser.id,'u');assert.deepEqual(res.body,{ok:true})}
  }
});

test('v1 failures produce environment-specific generic 500 or destroy after headers',async()=>{
  for(const environment of ['test','production'])for(const sent of [false,true]){
    const secret='synthetic-provider-marker';const f=fixture(()=>Promise.reject(Error(secret)),environment),res=response(sent);
    await dispatch(f,res);
    assert.equal(res.destroyed,sent);assert.equal(res.statusCode,sent?undefined:500);
    if(!sent)assert.deepEqual(res.body,{error:{type:'internal_error',message:environment==='production'?'Internal server error':'Internal server error.'}});
    const errors=f.logs.filter(args=>args[1]==='Unhandled error');
    assert.equal(errors.length,1);assert.equal(JSON.stringify([res.body,f.logs]).includes(secret),false);
    assert.equal(errors[0][0].err.message,'Internal server error.');
    assert.deepEqual(Object.values(f.counts),[1,0,1,1,1]);
  }
});

test('standalone auth continuation is claimed by real downstream dispatch',async()=>{
  for(const fail of [false,true]){
    const manager=new work.RequestWorkManager(),gate=deferred(),entered=deferred(),logs=[];
    const {auth,counts}=authFixture(manager,fail?'hash-fail':'valid',logs);
    const router=express.Router(),res=response();let args,drained=false,downstream=0,receivedError;
    router.use((req,res,next)=>{void auth.authenticateUserWithoutQuota(req,res,(...values)=>{args=values;next(...values)})});
    router.get('/auth',(_req,res)=>{
      const pending=manager.runDispatch(async()=>{downstream++;entered.resolve();await gate.promise;res.status(200).json({ok:true})});
      if(pending)void pending;
    });
    // Synthetic error middleware explicitly claims the forwarded handoff.
    router.use(work.trackedErrorHandler(async(error,_req,res)=>{receivedError=error;downstream++;entered.resolve();await gate.promise;res.status(500).json({error:'internal'})},manager));
    try{
      router.handle({method:'GET',url:'/auth',headers:{'x-api-key':'valid-key'}},res,()=>{throw Error('unexpected router exit')});
      await bounded(entered.promise,'auth downstream entry timeout');
      assert.ok(args);assert.equal(args.length,fail?1:0);
      if(fail){assert.ok(args[0] instanceof Error);assert.equal(args[0].message,'Internal server error.');assert.equal(receivedError.message,'Internal server error.')}
      assert.equal(downstream,1);
      const done=manager.stopAndDrain().then(()=>{drained=true});
      await Promise.resolve();assert.equal(drained,false);
      gate.resolve();await bounded(done,'auth downstream drain timeout');
      assert.equal(res.statusCode,fail?500:200);assert.equal(res.writableEnded,true);
      assert.deepEqual(Object.values(counts),fail?[1,0,0,0,0]:[1,1,0,0,0]);
      assert.equal(JSON.stringify([res.body,logs,args]).includes('synthetic-auth-marker'),false);
    }finally{gate.resolve()}
  }
});

test('v1 synchronous throws never invoke even a throwing downstream next',async()=>{
  const f=fixture(()=>{throw Error('synthetic-forward-marker')}),res=response();let calls=0;
  await dispatch(f,res,()=>{calls++;throw Error('synthetic-next-marker')});
  assert.equal(calls,0);assert.equal(res.statusCode,500);assert.equal(f.logs.filter(a=>a[1]==='Unhandled error').length,1);
  assert.equal(JSON.stringify([res.body,f.logs]).includes('synthetic-forward-marker'),false);
});

test('falsey, revoked proxy and Express route signals terminate locally without route skipping',async()=>{
  const revocable=Proxy.revocable({},{});revocable.revoke();
  for(const value of [undefined,null,false,0,'','route','router','failure',revocable.proxy]){
    const f=fixture(()=>Promise.reject(value)),res=response();let nextCalls=0;
    await dispatch(f,res,()=>{nextCalls++});
    assert.equal(nextCalls,0);assert.equal(res.statusCode,500);
    assert.deepEqual(res.body,{error:{type:'internal_error',message:'Internal server error.'}});
    const errors=f.logs.filter(a=>a[1]==='Unhandled error');
    assert.equal(errors.length,1);assert.equal(errors[0][0].err.message,'Internal server error.');
  }
});
