import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable, Duplex } from 'node:stream';
import { ServerResponse } from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const express = require('express');
function load(file, deps) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module = {exports:{}};
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {Promise, AbortController})((id) => {
    if (!Object.hasOwn(deps,id)) throw new Error('Unexpected dependency: '+id);
    return deps[id];
  }, module, module.exports);
  return module.exports;
}
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
async function bounded(p) { let timer; try { return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture timeout')),1500);})]); } finally {clearTimeout(timer);} }
function fixture(opts={}) {
  const started=gate(), release=gate(), handlerStarted=gate(), handlerRelease=gate();
  let calls=0;
  const logger={error(){},warn(){},debug(){}};
  const work=load('src/request-work.ts',{'node:async_hooks':require('node:async_hooks')});
  const user={id:'synthetic',name:'Synthetic',email:'synthetic@example.invalid',tier:'free',dailyLimit:10};
  const auth=load('src/auth/user-auth.ts',{
    '../db/repositories/users.js':{UserRepository:class {findByApiKeyHash(){return opts.invalid ? undefined : user;} reserveDailyQuota(){return {allowed:!opts.limit,used:10,user:opts.invalid ? undefined : user};}}},
    '../utils/encryption.js':{hashApiKey:()=> 'hash'}, '../utils/logger.js':{logger}, '../config/env.js':{env:{}},
    '../db/async-writer.js':{withAsyncWriter:async (fn,options)=>{started.resolve(options.signal); if(opts.holdQuota) await release.promise; if(opts.failQuota) throw new Error('synthetic-secret'); return fn({});}}, '../request-work.js':work
  });
  const v1=load('src/routes/v1.ts',{express,'../config/env.js':{env:{NODE_ENV:'test'}},'../auth/user-auth.js':auth,'../upstream/forward-chat.js':(()=>{const forward=async (_req,res)=>{calls++;if(opts.throwHandler) throw new Error('synthetic-secret');res.json({ok:true});handlerStarted.resolve();if(opts.holdHandler) await handlerRelease.promise;}; return {forwardChat:forward,forwardMessages:forward,forwardResponses:forward,anthropicErrorEnvelope(){},anthropicErrorBody:(_s,message)=>({type:'error',error:{type:'api_error',message}})};})(),'../request-work.js':work,'../utils/logger.js':{logger}}).default;
  const app=express();app.use('/v1',v1);app.get('/other',(_req,res)=>res.json({other:true}));
  for(let i=0;i<(opts.errorLayers||0);i++) app.use((error,_req,_res,next)=>next(error));
  if(opts.errorHandler) app.use(work.trackedErrorHandler(opts.errorHandler));
  function request(method='POST',url='/v1/chat/completions',key='synthetic',dispatch=true) {
    const req=new Readable({read(){}});req.method=method;req.url=url;req.headers=key ? {authorization:`Bearer ${key}`} : {};
    const res=new ServerResponse(req), chunks=[]; const socket=new Duplex({read(){},write(chunk,_enc,cb){chunks.push(Buffer.from(chunk));cb();}}); res.assignSocket(socket);
    const finished=gate(), closed=gate();res.on('finish',finished.resolve);res.on('close',closed.resolve);
    if(dispatch) app.handle(req,res);return {req,res,socket,chunks,finished,closed};
  }
  return {app,work,v1,request,started,release,handlerStarted,handlerRelease,get calls(){return calls;}};
}
test('each finite authenticated v1 route has one owned endpoint',()=>{
 const f=fixture();
 for(const path of ['/models','/messages','/responses','/chat/completions']) { // /responses: ADR 0019
  const route=f.v1.stack.find(layer=>layer.route?.path===path)?.route;
  assert.ok(route,`missing ${path}`);
  assert.equal(route.stack.length,1,`${path} must not hand off from auth to handler through Express next()`);
 }
});

const turn = () => new Promise(resolve => setImmediate(resolve));
async function notDrained(p) { let done=false; void p.then(()=>{done=true;}); await turn(); assert.equal(done,false); }
function body(r) { return JSON.parse(Buffer.concat(r.chunks).toString().split('\r\n\r\n')[1]); }

test('successful forwarding, missing and invalid keys, quota and known contracts', async()=>{
 for (const scenario of [
  {opts:{},method:'POST',path:'/v1/chat/completions',status:200,expected:{ok:true},calls:1},
  {opts:{},method:'POST',path:'/v1/chat/completions',key:'',status:401,calls:0},
  {opts:{invalid:true},method:'POST',path:'/v1/chat/completions',status:401,expected:{error:{type:'authentication_error',message:'Invalid API key.'}},calls:0},
  {opts:{limit:true},method:'POST',path:'/v1/chat/completions',status:429,expected:{error:{type:'rate_limit_exceeded',message:'Daily limit of 10 requests exceeded. Current usage: 10.'}},calls:0},
  {opts:{failQuota:true},method:'POST',path:'/v1/chat/completions',status:503,expected:{error:{type:'service_unavailable',message:'Unable to reserve daily quota.'}},calls:0},
  {opts:{},method:'GET',path:'/other',status:200,expected:{other:true},calls:0},
  // ADR 0019: /v1/messages and /v1/responses are owned inference endpoints (no longer a 501 placeholder).
  {opts:{},method:'POST',path:'/v1/messages',status:200,expected:{ok:true},calls:1},
  {opts:{},method:'POST',path:'/v1/responses',status:200,expected:{ok:true},calls:1},
  {opts:{},method:'GET',path:'/v1/models',status:200,calls:0},
 ]) {
  const f=fixture(scenario.opts), r=f.request(scenario.method,scenario.path,scenario.key);
  try {
   await bounded(r.finished.promise); await bounded(f.work.requestWork.stopAndDrain());
   assert.equal(r.res.statusCode,scenario.status); assert.equal(f.calls,scenario.calls);
   if(scenario.expected) assert.deepEqual(body(r),scenario.expected);
   if(scenario.path==='/v1/models') assert.deepEqual(body(r),{object:'list',data:[
    {id:'claude-3-5-sonnet-20241022',object:'model',owned_by:'anthropic'},
    {id:'claude-3-5-haiku-20241022',object:'model',owned_by:'anthropic'},
    {id:'gpt-4o',object:'model',owned_by:'openai'}, {id:'gpt-4o-mini',object:'model',owned_by:'openai'},
    {id:'gemini-2.0-flash-exp',object:'model',owned_by:'google'}]});
  } finally { f.release.resolve(); f.handlerRelease.resolve(); r.socket.destroy(); }
 }
});

test('disconnect and stop retain held authentication until writer settles; new admission denied',async()=>{
 const f=fixture({holdQuota:true}), r=f.request();
 try {
  const signal=await bounded(f.started.promise); r.res.destroy(); await bounded(r.closed.promise);assert.equal(signal.aborted,true);
  const drain=f.work.requestWork.stopAndDrain(); await notDrained(drain);
  const denied=f.request(); try {await bounded(denied.finished.promise);assert.equal(denied.res.statusCode,503);assert.deepEqual(body(denied),{error:{type:'service_unavailable',message:'Server is shutting down.'}});} finally {denied.socket.destroy();}
  const other=f.request('GET','/other');try {await bounded(other.finished.promise);assert.deepEqual(body(other),{other:true});} finally {other.socket.destroy();}
  f.release.resolve(); await bounded(drain);assert.equal(f.calls,0);
 } finally {f.release.resolve();r.socket.destroy();}
});

test('response completion does not release a pending handler promise',async()=>{
 const f=fixture({holdHandler:true}), r=f.request();
 try {
  await bounded(f.handlerStarted.promise);await bounded(r.finished.promise);r.socket.destroy();await bounded(r.closed.promise);
  const drain=f.work.requestWork.stopAndDrain();await notDrained(drain);
  f.handlerRelease.resolve();await bounded(drain);assert.equal(f.calls,1);
 } finally {f.handlerRelease.resolve();r.socket.destroy();}
});

test('v1 errors terminate locally without entering outer error handlers',async()=>{
 let outerCalls=0;
 const f=fixture({throwHandler:true,errorLayers:150,errorHandler:()=>{outerCalls++;}}),r=f.request();
 try {
  await bounded(r.finished.promise);await bounded(f.work.requestWork.stopAndDrain());
  assert.equal(outerCalls,0);assert.equal(r.res.statusCode,500);
  assert.deepEqual(body(r),{error:{type:'internal_error',message:'Internal server error.'}});
  assert.equal(JSON.stringify(body(r)).includes('synthetic-secret'),false);
 } finally {r.socket.destroy();}
});

test('next that would schedule then throw is never invoked',async()=>{
 let calls=0,scheduled=0;
 const f=fixture({throwHandler:true}),r=f.request('POST','/v1/chat/completions','synthetic',false);
 Object.setPrototypeOf(r.res,express.response); Object.setPrototypeOf(r.req,express.request);r.res.app=f.app;r.req.res=r.res;
 const endpoint=f.v1.stack.find(x=>x.route?.path==='/chat/completions').route.stack[0].handle;
 try {
  endpoint(r.req,r.res,()=>{calls++;setImmediate(()=>scheduled++);throw Error('synthetic-secret')});
  await bounded(r.finished.promise);await bounded(f.work.requestWork.stopAndDrain());await turn();
  assert.equal(calls,0);assert.equal(scheduled,0);assert.equal(r.res.statusCode,500);
  assert.equal(JSON.stringify(body(r)).includes('synthetic-secret'),false);
 } finally {r.socket.destroy();}
});
