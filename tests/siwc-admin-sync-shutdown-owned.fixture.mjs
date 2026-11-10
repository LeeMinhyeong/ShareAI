// Direct production SIWC admin handlers with synthetic DB and process state.
// No real SQLite, authentication, provider, listener or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require=createRequire(import.meta.url),ts=require('typescript');
const source=readFileSync(new URL('../src/upstream/siwc-login.ts',import.meta.url),'utf8');
const activeAnchor='const active = new Set<Promise<unknown>>();';
assert.equal(source.split(activeAnchor).length,2,'active set observation anchor must be unique');
const compiled=ts.transpileModule(source.replace(activeAnchor,`${activeAnchor} globalThis.__testActive = active;`),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
}).outputText;

const cases=[
  {method:'get',path:'/accounts',body:undefined,payload:{accounts:[]}},
  {method:'get',path:'/accounts/:id/routing',body:undefined,payload:{priority:2,weight:3}},
  {method:'post',path:'/accounts/:id/routing',body:{priority:2,weight:3},payload:{priority:2,weight:3}},
  {method:'get',path:'/accounts/:id/access',body:undefined,payload:{enabled:true,scope:'all',userIds:[]}},
  {method:'post',path:'/accounts/:id/access',body:{enabled:true,scope:'all',userIds:[]},payload:{enabled:true,scope:'all',userIds:[]}},
];
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stop timed out')),1000);})]);}finally{clearTimeout(timer);}}
function fixture(){
  const routes=new Map(),events=[];let dbCalls=0,stopPromise,activeBeforeStop,activeAtResponse;
  const router={use(){},get(path,handler){routes.set(`get ${path}`,handler);},post(path,handler){routes.set(`post ${path}`,handler);}};
  const module={exports:{}};
  const db={prepare(sql){return {
    get(...args){
      if(/^SELECT 1 FROM sqlite_master WHERE type\s*=\s*'table' AND name\s*=\s*'siwc_accounts'$/.test(sql)){assert.deepEqual(args,[]);return {present:1};}
      assert.deepEqual(args,['synthetic-account']);
      if(sql==='SELECT 1 FROM siwc_accounts WHERE id=?')return {present:1};
      if(sql==='SELECT priority, weight FROM siwc_routing_settings WHERE account_id=?')return {priority:2,weight:3};
      if(sql==='SELECT enabled, scope FROM siwc_access_policy WHERE account_id=?')return {enabled:1,scope:'all'};
      throw Error('unexpected get');
    },
    all(...args){
      if(sql==='SELECT id, name FROM siwc_accounts ORDER BY name, id')assert.deepEqual(args,[]);
      else if(sql==='SELECT user_id FROM siwc_access_users WHERE account_id=? ORDER BY user_id')assert.deepEqual(args,['synthetic-account']);
      else throw Error('unexpected all');
      return [];
    },
    run(...args){
      if(sql.startsWith('INSERT INTO siwc_routing_settings('))assert.deepEqual(args,['synthetic-account',2,3]);
      else if(sql.startsWith('INSERT INTO siwc_access_policy('))assert.deepEqual(args,['synthetic-account',1,'all']);
      else if(sql==='DELETE FROM siwc_access_users WHERE account_id=?')assert.deepEqual(args,['synthetic-account']);
      else throw Error('unexpected run');
      return {changes:1};
    },
  };},transaction(fn){return {immediate:()=>fn()};}};
  const deps={
    'node:http':{createServer(){throw Error('unexpected listener');}},'node:crypto':{randomUUID(){throw Error('unexpected UUID');}},
    express:{Router:()=>router},
    '../db/client.js':{getDb(){dbCalls++;events.push('getDb');if(dbCalls===1){activeBeforeStop=context.__testActive.size;stopPromise=module.exports.stopSiwc();void stopPromise.catch(()=>{});}return db;}},
    '../db/async-writer.js':{},'../utils/encryption.js':{},'./siwc-session.js':{},'./siwc.js':{},'./siwc-store.js':{},
  };
  const context=vm.createContext({module,exports:module.exports,Promise,URL,URLSearchParams,AbortController,
    setTimeout(){return {};},clearTimeout(){},fetch(){throw Error('unexpected provider');},
    require(id){if(!Object.hasOwn(deps,id))throw Error('unexpected dependency');return deps[id];}});
  vm.runInContext(compiled,context,{timeout:1000});
  module.exports.createSiwcRouter((_req,_res,next)=>next());
  const response=()=>{let status=200,payload;return {
    status(code){status=code;return this;},sendStatus(code){status=code;return this;},
    json(value){if(activeAtResponse===undefined)activeAtResponse=context.__testActive.size;payload=value;return this;},
    get statusCode(){return status;},get payload(){return payload;},
  };};
  return {routes,response,events,stop:()=>module.exports.stopSiwc(),get active(){return context.__testActive.size;},get dbCalls(){return dbCalls;},get stopPromise(){return stopPromise;},
    get activeBeforeStop(){return activeBeforeStop;},get activeAtResponse(){return activeAtResponse;}};
}
for(const item of cases)for(const mode of ['ownership','post-stop']){
  test(`${item.method.toUpperCase()} ${item.path}: ${mode}`,{timeout:3000},async()=>{
    const f=fixture(),handler=f.routes.get(`${item.method} ${item.path}`);
    assert.equal(typeof handler,'function');
    const request={params:{id:'synthetic-account'},body:item.body},res=f.response();
    await Promise.resolve(handler(request,res,()=>{throw Error('unexpected next');}));
    assert.equal(res.statusCode,200,'positive request failed');
    assert.equal(JSON.stringify(res.payload),JSON.stringify(item.payload),'positive response mismatch');
    assert.equal(f.dbCalls,1,'expected DB entry not observed');
    assert.ok(f.stopPromise,'reentrant stop not triggered');
    await bounded(f.stopPromise);
    if(mode==='ownership'){
      assert.equal(f.activeBeforeStop,1,'DB work was not owned before stop');
      assert.equal(f.activeAtResponse,1,'ownership was not held through response call');
    }else{
      const denied=f.response();
      await Promise.resolve(handler(request,denied,()=>{throw Error('unexpected next');}));
      assert.equal(denied.statusCode,503,'post-stop request was not rejected');
      assert.equal(f.dbCalls,1,'post-stop request accessed DB');
    }
  });
}
test('a synchronous validation throw reaches Express next and releases ownership',{timeout:3000},async()=>{
  const f=fixture(),handler=f.routes.get('post /accounts/:id/routing');
  const expected=Error('synthetic validation throw'),request={params:{id:'synthetic-account'}};
  Object.defineProperty(request,'body',{get(){throw expected;}});
  let received,count=0;
  const result=handler(request,f.response(),error=>{received=error;count++;});
  await Promise.resolve(result).catch(()=>{});
  await bounded(f.stop());
  assert.equal(count,1,'synchronous error was not forwarded exactly once');
  assert.equal(received,expected,'forwarded a different error');
  assert.equal(f.active,0,'failed handler leaked ownership');
  assert.equal(f.dbCalls,0,'validation failure unexpectedly accessed DB');
});
