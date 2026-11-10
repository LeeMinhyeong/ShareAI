// Direct production logout handler with synthetic router/writers; no DB, HTTP
// listener, credentials or provider. Not the SIWC callback-drain fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=readFileSync(new URL('../src/upstream/siwc-login.ts',import.meta.url),'utf8');
// Test-only observations at the actual stop resolver and active set. A promise
// reaction may run too late to detect stop resolving immediately before json().
const activeAnchor='const active = new Set<Promise<unknown>>();';
const stopAnchor='if (timer) clearTimeout(timer); resolve();';
assert.equal(source.split(activeAnchor).length,2,'active observation anchor must be unique');
assert.equal(source.split(stopAnchor).length,2,'stop observation anchor must be unique');
const instrumented=source.replace(activeAnchor,`${activeAnchor} globalThis.__logoutTestActive = active;`)
  .replace(stopAnchor,'if (timer) clearTimeout(timer); globalThis.__logoutTestStopResolved = true; resolve();');
const compiled=ts.transpileModule(instrumented,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),500);})]);}finally{clearTimeout(timer);}}

test('SIWC stop retains an admitted logout through its final DB verification',{timeout:3000},async()=>{
  const first=deferred(),second=deferred(),secondEntered=deferred(),routes=new Map(),events=[];
  const router={use(){},get(){},post(path,handler){routes.set(path,handler);}};
  let writerCalls=0,stopped=false,stopSettled=false,responseSawSettled,responseOwned,handlerPromise,stopPromise;
  const deps={
    'node:http':{createServer(){throw Error('unexpected listener');}},
    'node:crypto':{randomUUID(){throw Error('unexpected UUID');}},
    express:{Router:()=>router},
    '../db/client.js':{getDb(){throw Error('unexpected direct DB');}},
    '../db/async-writer.js':{withAsyncWriter(){
      writerCalls++;events.push(stopped?'writer-after-stop':'writer-before-stop');
      if(writerCalls===1)return first.promise;
      if(writerCalls===2){secondEntered.resolve();return second.promise;}
      throw Error('unexpected writer');
    }},
    '../utils/encryption.js':{CredentialVault:class {}},
    './siwc-session.js':{},'./siwc.js':{},'./siwc-store.js':{},
  };
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,Promise,URL,URLSearchParams,AbortController,__logoutTestStopResolved:false,
    setTimeout(){return {};},clearTimeout(){},fetch(){throw Error('unexpected provider');},
    require(id){if(!Object.hasOwn(deps,id))throw Error('unexpected dependency');return deps[id];}});
  vm.runInContext(compiled,context,{timeout:1000});
  module.exports.createSiwcRouter((_req,_res,next)=>next());
  const handler=routes.get('/accounts/:id/logout');
  assert.equal(typeof handler,'function');
  let status=200,payload;
  const res={status(code){status=code;return this;},sendStatus(code){status=code;return this;},json(value){responseSawSettled=context.__logoutTestStopResolved;responseOwned=context.__logoutTestActive.has(handlerPromise);payload=value;return this;}};
  try{
    handlerPromise=handler({params:{id:'synthetic-account'}},res);
    void Promise.resolve(handlerPromise).catch(()=>{});
    assert.equal(writerCalls,1,'logout did not enter the first DB writer');
    stopped=true;
    stopPromise=module.exports.stopSiwc();
    void stopPromise.then(()=>{stopSettled=true;},()=>{stopSettled=true;});
    await turn();
    const stoppedBeforeRelease=stopSettled;
    let deniedStatus;
    const denied={status(code){deniedStatus=code;return this;},json(){return this;}};
    await handler({params:{id:'synthetic-account'}},denied);
    assert.equal(deniedStatus,503,'new logout was not rejected after stop');
    assert.equal(writerCalls,1,'rejected logout reached a DB writer');
    first.resolve({kind:'signed-out',result:{credential:{clientId:'synthetic-client'},revision:'synthetic-revision',remoteUncertain:false}});
    await bounded(secondEntered.promise,'second writer entry');
    await turn();
    const stoppedBeforeSecondRelease=stopSettled;
    second.resolve({certain:true,changed:false});
    await bounded(handlerPromise,'logout completion');
    await bounded(stopPromise,'stop completion');
    assert.equal(context.__logoutTestStopResolved,true,'stop completion observation did not run');
    assert.equal(status,200,'logout positive control failed');
    assert.equal(payload?.localSignedOut,true,'logout did not reach its final response');
    assert.deepEqual(events,['writer-before-stop','writer-after-stop']);
    assert.equal(writerCalls,2,'final verification writer did not execute');
    assert.equal(stoppedBeforeRelease,false,'SIWC stop settled before admitted logout finished');
    assert.equal(stoppedBeforeSecondRelease,false,'SIWC stop settled before final verification finished');
    assert.equal(responseSawSettled,false,'SIWC stop settled before logout response call');
    assert.equal(responseOwned,true,'logout ownership released before response call');
  }finally{
    first.resolve({kind:'signed-out',result:{credential:{clientId:'synthetic-client'},revision:'synthetic-revision',remoteUncertain:false}});
    second.resolve({certain:true,changed:false});
    if(handlerPromise)await bounded(Promise.resolve(handlerPromise),'logout cleanup').catch(()=>{});
    if(stopPromise)await bounded(Promise.resolve(stopPromise),'stop cleanup').catch(()=>{});
  }
});
