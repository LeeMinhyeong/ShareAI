// Synthetic production modules: no sockets, database, or external services.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(path, deps = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, name => { if (name === 'node:async_hooks') return require(name); if (!(name in deps)) throw Error(`unexpected import ${name}`); return deps[name]; });
  return exports;
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject}; }
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer=setTimeout(()=>reject(Error(`${label} timed out`)), 1000); })]); }
  finally { clearTimeout(timer); }
}
const logger = {info(){},error(){},warn(){},debug(){}};
const user = {id:'synthetic',name:'synthetic',email:'synthetic',tier:'free',dailyLimit:2};
function authFor(gate, requestWork = new (load('../src/request-work.ts').RequestWorkManager)()) { return load('../src/auth/user-auth.ts', {
  '../db/repositories/users.js':{UserRepository:class { findByApiKeyHash(){ return user; }}},
  '../utils/encryption.js':{hashApiKey:()=> 'hash'}, '../utils/logger.js':{logger},
  '../config/env.js':{env:{}}, '../db/async-writer.js':{withAsyncWriter:()=>gate.promise}, '../request-work.js':{requestWork}
}); }
function response() { return Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,status(){return this},json(){this.writableEnded=true;return this}}); }
function request() { return {headers:{authorization:'Bearer synthetic'}}; }
test('authentication exposes completion after a disconnected pending reservation', async () => {
  const gate=deferred(), auth=authFor(gate), res=response(); let called=false;
  let done;
  try {
    done=auth.authenticateUser(request(),res,()=>{called=true});
    assert.equal(typeof done?.then,'function','authentication must expose its actual async lifetime');
    res.destroyed=true; res.emit('close'); gate.resolve({allowed:true,user});
    await bounded(done,'disconnected authentication'); assert.equal(called,false);
  } finally {
    gate.resolve({allowed:true,user});
    if (done) await bounded(done,'disconnected authentication cleanup');
  }
});
test('standalone auth contains next failures and normalizes response exceptions', async () => {
  for (const kind of ['next', 'response']) {
    const {RequestWorkManager,trackedErrorHandler}=load('../src/request-work.ts');
    const manager=new RequestWorkManager(), gate=deferred(), auth=authFor(gate,manager), res=response(), req=request();
    const error=Error(`${kind} secret`), statuses=[], seen=[], reached=deferred();
    res.status=n=>{statuses.push(n);return res};
    if (kind === 'response') res.json=()=>{throw error};
    const wrapped=trackedErrorHandler(e=>{seen.push(e);reached.resolve()},manager);
    try {
      const done=auth.authenticateUser(req,res,e=>{
        if (kind === 'response') return wrapped(e,req,res,()=>{});
        seen.push(e); reached.resolve();
        void manager.runDispatch(()=>{}); // Claim the standalone handoff before throwing.
        throw error;
      });
      gate.resolve(kind === 'next' ? {allowed:true,user} : {allowed:false,user,used:2});
      await bounded(reached.promise,`${kind} continuation`);
      await bounded(done,`${kind} authentication`);
      assert.equal(seen.length,1);
      if (kind === 'next') assert.equal(seen[0],undefined);
      else {
        assert.ok(seen[0] instanceof Error);
        assert.equal(seen[0].message,'Internal server error.');
        assert.equal(String(seen[0].stack).includes('secret'),false);
      }
      assert.deepEqual(statuses,kind === 'next' ? [500] : [429]);
    } finally {
      gate.resolve({allowed:false,user,used:2});
      await bounded(manager.stopAndDrain(),`${kind} auth drain`);
    }
  }
});
test('chat route registers work before auth and keeps it until forward settles', async () => {
  const gate=deferred(), forwardGate=deferred(); let route, forwarded=false, drained=false;
  const requestWork=new (load('../src/request-work.ts').RequestWorkManager)(), auth=authFor(gate,requestWork);
  const router={post(path,...handlers){if(path==='/chat/completions') route=handlers},get(){}};
  load('../src/routes/v1.ts', {'express':{Router:()=>router}, '../auth/user-auth.js':auth, '../config/env.js':{env:{NODE_ENV:'test'}},
    '../upstream/forward-chat.js':{forwardChat:async (_req,res)=>{forwarded=true; res.writableEnded=true; await forwardGate.promise;}},
    '../request-work.js':{requestWork}, '../utils/logger.js':{logger}});
  const req=request(), res=response(); let error;
  let drain;
  try {
    route[0](req,res,e=>{error=e});
    drain=requestWork.stopAndDrain().then(()=>{drained=true});
    await Promise.resolve(); gate.resolve({allowed:true,user});
    for(let i=0;i<30&&!forwarded;i++) await Promise.resolve();
    assert.equal(forwarded,true); assert.equal(drained,false,'response completion must not finish work');
  } finally { gate.resolve({allowed:true,user}); forwardGate.resolve(); await bounded(drain ?? requestWork.stopAndDrain(),'owned route drain'); }
  assert.equal(drained,true); assert.equal(error,undefined);
});
function fixture(gates, forward) {
  const {RequestWorkManager}=load('../src/request-work.ts');
  const requestWork=new RequestWorkManager(); let route, index=0;
  const auth=load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js':{UserRepository:class { findByApiKeyHash(){return user;} }},
    '../utils/encryption.js':{hashApiKey:()=> 'hash'}, '../utils/logger.js':{logger},
    '../config/env.js':{env:{}}, '../db/async-writer.js':{withAsyncWriter:()=>gates[index++].promise}, '../request-work.js':{requestWork}
  });
  const router={post(path,...handlers){if(path==='/chat/completions') route=handlers},get(){}};
  load('../src/routes/v1.ts', {'express':{Router:()=>router}, '../auth/user-auth.js':auth, '../config/env.js':{env:{NODE_ENV:'test'}},
    '../upstream/forward-chat.js':{forwardChat:forward}, '../request-work.js':{requestWork}, '../utils/logger.js':{logger}});
  return {requestWork,route:(req,res,next)=>route[0](req,res,next)};
}
async function tick() { for(let i=0;i<12;i++) await Promise.resolve(); }

test('owned v1 synthetic auth dependency rejections stay local and never skip the route', async () => {
  for (const signal of [Error('synthetic auth secret'), 'route', 'router', undefined, null, false, 0, '']) {
    let route, called=0, authCalls=0, quota; const nextCalls=[], logs=[], completed=deferred();
    const router={post(path,...handlers){if(path==='/chat/completions') route=handlers},get(){}};
    const {RequestWorkManager}=load('../src/request-work.ts');
    const requestWork=new RequestWorkManager();
    const auth=async (_req,_res,_handler,reserveQuota)=>{
      authCalls++;
      quota=reserveQuota;
      throw signal;
    };
    load('../src/routes/v1.ts', {'express':{Router:()=>router},
      '../auth/user-auth.js':{authenticateUserInDispatch:auth}, '../config/env.js':{env:{NODE_ENV:'test'}},
      '../upstream/forward-chat.js':{forwardChat:()=>called++}, '../request-work.js':{requestWork},
      '../utils/logger.js':{logger:{...logger,error:(...args)=>logs.push(args)}}});
    const req=request(),res=response(); let status,body;
    res.status=value=>{status=value;return res};
    res.json=value=>{body=value;res.writableEnded=true;completed.resolve();return res};
    try {
      assert.equal(route.length,1);
      route[0](req,res,(...args)=>nextCalls.push(args));
      await bounded(completed.promise,'owned auth response');
      assert.equal(authCalls,1);
      assert.equal(quota,true);
      assert.equal(called,0);
      assert.deepEqual(nextCalls,[]);
      assert.equal(status,500);
      assert.deepEqual(body,{error:{type:'internal_error',message:'Internal server error.'}});
      assert.equal(logs.length,1);
      assert.equal(logs[0][0].err.message,'Internal server error.');
      assert.equal(JSON.stringify({body,logs}).includes('synthetic auth secret'),false);
      assert.equal(String(logs[0][0].err.stack).includes('synthetic auth secret'),false);
    } finally {
      await bounded(requestWork.stopAndDrain(),'owned auth rejection drain');
    }
  }
});
test('real owned v1 authentication and handler failures are contained', async () => {
  const marker='synthetic-private-marker';
  const revoked=Proxy.revocable({}, {get(){throw Error(marker)}, getPrototypeOf(){throw Error(marker)}, ownKeys(){throw Error(marker)}});
  revoked.revoke();
  const hostile=new Proxy({}, {get(){throw Error(marker)}, getPrototypeOf(){throw Error(marker)}, ownKeys(){throw Error(marker)}});
  const signals=[Error(marker), marker, revoked.proxy, hostile, 'route', 'router', undefined, null, false, 0, ''];
  for (const stage of ['hash', 'handler', 'writer']) {
    for (const signal of signals) {
      const {RequestWorkManager}=load('../src/request-work.ts'), requestWork=new RequestWorkManager();
      const gate=deferred(), completed=deferred(), logs=[], nextCalls=[];
      void gate.promise.catch(()=>{});
      let hashes=0, reservations=0, forwards=0;
      const safeLogger={info:(...a)=>logs.push(a),error:(...a)=>logs.push(a),warn:(...a)=>logs.push(a),debug:(...a)=>logs.push(a)};
      const db={fixture:true};
      const auth=load('../src/auth/user-auth.ts', {
        '../db/repositories/users.js':{UserRepository:class {
          reserveDailyQuota(hash, unused, received) {
            assert.equal(hash,'synthetic-hash'); assert.equal(unused,undefined); assert.equal(received,db);
            reservations++; return gate.promise;
          }
          findByApiKeyHash(){throw Error('unexpected lookup');}
        }},
        '../utils/encryption.js':{hashApiKey:key=>{hashes++; assert.equal(key,'synthetic'); if(stage==='hash') throw signal; return 'synthetic-hash';}},
        '../utils/logger.js':{logger:safeLogger}, '../config/env.js':{env:{}},
        '../db/async-writer.js':{withAsyncWriter:(callback,options)=>{assert.equal(options.signal.aborted,false); return callback(db);}},
        '../request-work.js':{requestWork}
      });
      const router=load('../src/routes/v1.ts', {'express':{Router:require('express').Router},
        '../auth/user-auth.js':auth, '../config/env.js':{env:{NODE_ENV:'test'}},
        '../upstream/forward-chat.js':{forwardChat:()=>{forwards++; throw signal;}},
        '../request-work.js':{requestWork}, '../utils/logger.js':{logger:safeLogger}}).default;
      const req={...request(),method:'POST',url:'/chat/completions',originalUrl:'/chat/completions',baseUrl:''};
      const res=response(); let status, body;
      res.status=value=>{status=value;return res};
      res.json=value=>{body=value;res.writableEnded=true;completed.resolve();return res};
      try {
        router.handle(req,res,(...args)=>nextCalls.push(args));
        if(stage==='writer') gate.reject(signal); else gate.resolve({allowed:true,user});
        await bounded(completed.promise,'real owned response');
        try {
        assert.equal(hashes,1,'hash called once');
        assert.equal(reservations,stage==='hash'?0:1,'quota reservation count');
        assert.equal(forwards,stage==='handler'?1:0,'unauthorized request must not forward');
        assert.equal(nextCalls.length,0,'owned failure must not enter Express next');
        assert.equal(status===(stage==='writer'?503:500),true,'generic failure status');
        assert.equal(body?.error?.type===(stage==='writer'?'service_unavailable':'internal_error'),true,'generic error type');
        assert.equal(body?.error?.message===(stage==='writer'?'Unable to reserve daily quota.':'Internal server error.'),true,'generic error message');
        const routeLog=logs.find(entry=>entry[1]==='Unhandled error');
        assert.equal(Boolean(routeLog),stage!=='writer','route failure logged only for escaping errors');
        if (routeLog) {
          assert.equal(routeLog[0].err.message==='Internal server error.',true,'normalized log message');
          assert.equal(String(routeLog[0].err.stack).includes(marker),false,'normalized stack contains no marker');
        }
        let clean=false;
        try { clean=!JSON.stringify({body,logs}).includes(marker); } catch { /* hostile values are unsafe */ }
        assert.equal(clean,true,'response and logs contain no marker or hostile values');
        } catch { throw Error('owned v1 failure assertions failed'); }
      } finally {
        gate.resolve({allowed:false,user,used:2});
        await bounded(requestWork.stopAndDrain(),'real owned drain');
      }
    }
  }
});

test('real manager drains disconnected auth and post-response forwarding across concurrent requests', async () => {
  const a=deferred(), b=deferred(), forward=deferred(); let calls=0, drained=false;
  const {requestWork,route}=fixture([a,b],async (_req,res)=>{calls++; res.writableEnded=true; await forward.promise;});
  const x=response(), y=response(), errors=[];
  let done;
  try {
    route(request(),x,e=>errors.push(e)); route(request(),y,e=>errors.push(e));
    await tick(); x.destroyed=true; x.emit('close');
    b.resolve({allowed:true,user}); await tick(); assert.equal(calls,1);
    done=requestWork.stopAndDrain().then(()=>{drained=true});
    const rejected=response(); let status; rejected.status=n=>{status=n;return rejected};
    route(request(),rejected,e=>errors.push(e)); assert.equal(status,503);
    await tick(); assert.equal(drained,false);
    a.resolve({allowed:true,user}); await tick(); assert.equal(drained,false); assert.equal(calls,1);
  } finally { a.resolve({allowed:true,user}); b.resolve({allowed:true,user}); forward.resolve(); await bounded(done ?? requestWork.stopAndDrain(),'concurrent route drain'); }
  assert.equal(drained,true); assert.deepEqual(errors,[]);
  await bounded(requestWork.stopAndDrain(),'repeat drain');
});
test('auth rejection, missing key, and thrown response release tracked work', async () => {
  const a=deferred(), {requestWork,route}=fixture([a],()=>{throw Error('must not forward')});
  const errors=[], res=response(), missing=response(); let status,body,destroyed=0;
  res.json=()=>{throw Error('response failed secret')}; res.destroy=()=>{destroyed++};
  missing.status=n=>{status=n;return missing}; missing.json=v=>{body=v;return missing};
  try { route(request(),res,e=>errors.push(e)); route({headers:{}},missing,e=>errors.push(e)); await tick(); a.reject(Error('synthetic auth failure secret')); await tick(); }
  finally { a.resolve({allowed:false,user,used:2}); await bounded(requestWork.stopAndDrain(),'auth failure drain'); }
  assert.deepEqual(errors,[]); assert.equal(destroyed,1); assert.equal(status,401);
  assert.equal(body.error.type,'authentication_error');
});
test('forward rejection is normalized locally and releases work', async () => {
  const a=deferred(), {requestWork,route}=fixture([a],async()=>{throw Error('forward failed secret')});
  const errors=[],res=response(); let status,body;
  res.status=n=>{status=n;return res}; res.json=v=>{body=v;return res};
  try { route(request(),res,e=>errors.push(e)); await tick(); a.resolve({allowed:true,user}); await tick(); }
  finally { a.resolve({allowed:true,user}); await bounded(requestWork.stopAndDrain(),'forward failure drain'); }
  assert.deepEqual(errors,[]); assert.equal(status,500);
  assert.deepEqual(body,{error:{type:'internal_error',message:'Internal server error.'}});
  assert.equal(JSON.stringify(body).includes('secret'),false);
});

test('owned chat dispatch rejects missing and invalid keys and quota denial without forwarding', async () => {
  const invalid=deferred(), denied=deferred(), completed=[deferred(),deferred(),deferred()];
  let forwarded=0;
  const {requestWork,route}=fixture([invalid,denied],()=>{forwarded++});
  const replies=completed.map(done=>{
    const res=response();
    res.status=code=>{res.code=code;return res};
    res.json=body=>{res.body=body;res.writableEnded=true;done.resolve();return res};
    return res;
  });
  const errors=[];
  try {
    route({headers:{}},replies[0],error=>errors.push(error));
    route(request(),replies[1],error=>errors.push(error));
    route(request(),replies[2],error=>errors.push(error));
    invalid.resolve({allowed:false,user:undefined});
    denied.resolve({allowed:false,user,used:2});
    await bounded(Promise.all(completed.map(done=>done.promise)),'auth responses');
    assert.deepEqual(replies.map(res=>res.code),[401,401,429]);
    assert.deepEqual(replies.map(res=>res.body.error.type),['authentication_error','authentication_error','rate_limit_exceeded']);
    assert.equal(replies[2].body.error.message,'Daily limit of 2 requests exceeded. Current usage: 2.');
    assert.equal(forwarded,0);
    assert.deepEqual(errors,[]);
  } finally {
    invalid.resolve({allowed:false,user:undefined});
    denied.resolve({allowed:false,user,used:2});
    await bounded(requestWork.stopAndDrain(),'auth denial drain');
  }
});
