// Capability identity and conservative delivery tests; no sockets or storage.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript'),express=require('express');
const code=ts.transpileModule(readFileSync(new URL('../src/request-work.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api={};vm.runInThisContext(`(function(exports,require){${code}\n})`)(api,require);
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function bounded(p){let timer;return Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('barrier timed out')),400))]).finally(()=>clearTimeout(timer))}
function res(){return {statusCode:200,status(n){this.statusCode=n;return this},json(){return this}}}
test('forged symbols and replay cannot claim an error capability',async()=>{
 const m=new api.RequestWorkManager(),q={},gate=deferred(),entered=deferred();let wrapper,calls=0,seen;
 m.ownedDispatch(s=>s.forwardError(Error('original'),e=>wrapper=e));const drain=m.stopAndDrain();
 const forged=Error('forged');for(const symbol of Object.getOwnPropertySymbols(wrapper)) Object.defineProperty(forged,symbol,Object.getOwnPropertyDescriptor(wrapper,symbol));
 const h=api.trackedErrorHandler(async e=>{seen=e;calls++;entered.resolve();await gate.promise},m),bad=res();h(forged,q,bad,()=>{});assert.equal(bad.statusCode,503);
 h(wrapper,q,res(),()=>{});await bounded(entered.promise);const replay=res();h(wrapper,q,replay,()=>{});assert.equal(replay.statusCode,503);assert.equal(calls,1);assert.equal(seen.message,'original');gate.resolve();await bounded(drain);
});
test('scheduled delivery before a throw retains ownership until actual handler',async()=>{
 const m=new api.RequestWorkManager(),q={},release=deferred(),scheduled=deferred();let calls=0;
 const h=api.trackedErrorHandler(()=>{calls++},m);
 assert.throws(()=>m.ownedDispatch(s=>s.forwardError('route',e=>{void release.promise.then(()=>{h(e,q,res(),()=>{});scheduled.resolve()});throw Error('delivery failed')})),/delivery failed/);
 let done=false;const drain=m.stopAndDrain().then(()=>done=true);await Promise.resolve();assert.equal(done,false);release.resolve();await bounded(scheduled.promise);await bounded(drain);assert.equal(calls,1);
});
test('Express deferred error dispatch across more than 100 layers retains identity',async()=>{
 const m=new api.RequestWorkManager(),router=express.Router(),q={method:'GET',url:'/'},r=res(),entered=deferred();let original=Error('deferred'),seen;
 router.use((_q,_r,next)=>next(original));for(let i=0;i<150;i++)router.use((err,_q,_r,next)=>next(err));
 const h=api.trackedErrorHandler(err=>{seen=err;entered.resolve()},m);
 m.ownedDispatch(scope=>router.handle(q,r,err=>scope.forwardError(err,wrapped=>h(wrapped,q,r,()=>{}))));
 const drain=m.stopAndDrain();await bounded(entered.promise);await bounded(drain);assert.equal(seen,original);
});
