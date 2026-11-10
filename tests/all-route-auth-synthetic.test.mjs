// Scope: the admin, nested SIWC and v1 routers only; app-level mounts in
// server.ts are not enumerated here. Actual Express dispatch over these routers with
// synthetic dependencies: no database, listener, network, or credentials.
// A JS dependency allowlist is not an OS sandbox.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript'), express = require('express');

function load(path, deps, mutate = x => x) {
  const original = readFileSync(new URL(path, import.meta.url), 'utf8');
  const input = mutate(original);
  const code = ts.transpileModule(input, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const out = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(out, name => {
    if (!Object.hasOwn(deps,name)) throw Error(`unexpected dependency ${name}`);
    return deps[name];
  });
  return out;
}
// Mutation helper: the replacement must change the source, or the control is void.
const mutation = (pattern, replacement) => src => {
  const changed = src.replace(pattern, replacement);
  assert.notEqual(changed, src, `mutation pattern not found: ${pattern}`);
  return changed;
};
const forbidden = () => { throw Error('unexpected downstream call'); };
// Any member is a function that fails when called; module-level construction stays inert.
const inertModule = () => new Proxy({}, {get:(_t, key) => key === '__esModule' ? undefined : forbidden});
const logger = {warn(){},debug(){},error(){},info(){}};
const VALID = 'synthetic-valid';
const validUser = {id:'synthetic-user', name:'n', email:'e', tier:'free', dailyLimit:10};
class Repo {
  findByApiKeyHash(hash){ return hash === `h:${VALID}` ? validUser : undefined; }
  reserveDailyQuota(hash){ return hash === `h:${VALID}` ? {user:validUser, allowed:true, used:0} : {user:undefined}; }
}
const rejectingRepo = class { constructor(){return new Proxy(this,{get:()=>forbidden});} };

function fixture({admin: mutateAdmin, v1: mutateV1, siwc: mutateSiwc} = {}) {
  const work = load('../src/request-work.ts', {'node:async_hooks':require('node:async_hooks')});
  const manager = new work.RequestWorkManager();
  let authCalls = 0, downstream = 0;
  const realAuth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js':{UserRepository:Repo}, '../utils/encryption.js':{hashApiKey:key => `h:${key}`},
    '../utils/logger.js':{logger}, '../config/env.js':{env:{ADMIN_API_KEY:'synthetic-admin'}},
    '../db/async-writer.js':{withAsyncWriter:fn=>fn({})}, '../request-work.js':{requestWork:manager},
  });
  const auth = {...realAuth,
    authenticateAdmin(...args){authCalls++; return realAuth.authenticateAdmin(...args);},
    authenticateUserInDispatch(...args){authCalls++; return realAuth.authenticateUserInDispatch(...args);},
  };
  const siwc = load('../src/upstream/siwc-login.ts', {
    'node:http':{createServer:forbidden}, 'node:crypto':{randomUUID:forbidden}, express,
    '../db/client.js':inertModule(), '../db/async-writer.js':inertModule(), '../utils/encryption.js':inertModule(),
    './siwc-session.js':inertModule(), './siwc.js':inertModule(), './siwc-store.js':inertModule(),
  }, mutateSiwc);
  let siwcRouter;
  const adminModule = load('../src/routes/admin.ts', {
    express, '../auth/user-auth.js':auth, '../request-work.js':{requestWork:manager},
    '../db/repositories/users.js':{UserRepository:rejectingRepo}, '../db/repositories/accounts.js':{AccountRepository:rejectingRepo},
    '../db/repositories/usage-logs.js':{UsageLogRepository:rejectingRepo},
    '../db/repositories/settings.js':{SettingsRepository:rejectingRepo,STRATEGIES:[]},
    '../utils/encryption.js':{generateApiKey:forbidden,hashApiKey:forbidden}, '../utils/logger.js':{logger},
    '../upstream/oauth.js':{setOnLoginComplete(){},startLogin:forbidden,finishLogin:forbidden,getFlow:forbidden,parseImportedCredential:forbidden},
    '../upstream/siwc-login.js':{createSiwcRouter:guard => (siwcRouter = siwc.createSiwcRouter(guard))},
    './routing-snapshot.js':{routingSnapshot:forbidden},
  }, mutateAdmin);
  const v1 = load('../src/routes/v1.ts', {express,'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},
    '../utils/logger.js':{logger},'../config/env.js':{env:{NODE_ENV:'test'}},
    '../upstream/forward-chat.js':{forwardChat(_req,res){downstream++; res.status(200).json({ok:true});}}}, mutateV1).default;
  assert.ok(siwcRouter, 'admin must create the SIWC router');
  return {admin:adminModule.default, noStore:adminModule.routingSnapshotNoStore, siwcRouter, siwcNoStore:siwc.noStoreSiwc,
    v1, manager, guard:auth.authenticateAdmin,
    get authCalls(){return authCalls;}, get downstream(){return downstream;}};
}

function routes(router, prefix = '') {
  const entries = router.stack.filter(layer=>layer.route).flatMap(layer=>Object.keys(layer.route.methods)
    .map(method=>({method:method.toUpperCase(), path:prefix + layer.route.path, route:layer.route})));
  for (const e of entries) assert.equal(typeof e.route.path,'string', 'unsupported route path must not be omitted');
  return entries;
}
const urlFor = path => path.replace(/:([A-Za-z0-9_]+)/g,'fixture');
const bounded = async (promise, ms, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} deadline`)),ms)})]); }
  finally { clearTimeout(timer); }
};

async function request(router, method, url, headers, getAuth, preAuthHeaders = ['cache-control']) {
  let finish; const done = new Promise(resolve=>{finish=resolve});
  const violations = [];
  const check = (ok, message) => { if (!ok) violations.push(message); return ok; };
  const res = Object.assign(new EventEmitter(), {statusCode:200, destroyed:false,writableEnded:false,headersSent:false, headers:{},
    set(name,value){ check(getAuth() > 0 || preAuthHeaders.includes(name.toLowerCase()), `pre-auth header ${name}`); this.headers[name.toLowerCase()]=value; return this;},
    status(code){ check(getAuth()>0,'status before auth'); this.statusCode=code; return this;},
    json(body){ check(getAuth()>0,'response before auth'); this.body=body; this.writableEnded=true; finish(); return this;},
    send(body){ this.body=body; this.writableEnded=true; finish(); return this;},
    destroy(){ this.destroyed=true; finish(); },
  });
  const req = {method,url,headers,body:{}};
  router.handle(req,res,error=>{ if(error) res.dispatchError=error; else res.missed=true; finish(); });
  await bounded(done, 2000, `dispatch ${method} ${url}`);
  assert.equal(res.dispatchError,undefined, `dispatch error ${method} ${url}`);
  assert.equal(res.missed,undefined,`route not matched ${method} ${url}`);
  assert.deepEqual(violations, [], `${method} ${url}`);
  return res;
}

// Every non-route layer must be accounted for: an unknown pre-route middleware
// could respond or touch data before any route-level guard runs.
function adminMounts(f) {
  const mounts = f.admin.stack.filter(layer => !layer.route);
  assert.equal(mounts.length, 2, 'unexpected admin middleware');
  const prefixes = [];
  for (const layer of mounts) {
    assert.equal(layer.handle, f.siwcRouter, 'unexpected admin middleware');
    const matched = ['/accounts/siwc', '/siwc'].filter(prefix => layer.match(`${prefix}/probe`));
    assert.equal(matched.length, 1, 'ambiguous SIWC mount');
    prefixes.push(matched[0]);
  }
  assert.deepEqual(prefixes.sort(), ['/accounts/siwc', '/siwc']);
  // The SIWC router must apply no-store then the injected admin guard before any route.
  const firstRoute = f.siwcRouter.stack.findIndex(layer => layer.route);
  const pre = f.siwcRouter.stack.slice(0, firstRoute);
  assert.deepEqual(pre.map(layer => layer.handle), [f.siwcNoStore, f.guard], 'siwc guard');
  assert.ok(f.siwcRouter.stack.slice(firstRoute).every(layer => layer.route), 'siwc middleware after routes');
  return prefixes;
}

async function checkAdmin(f) {
  const prefixes = adminMounts(f);
  const direct = routes(f.admin);
  // Pin the SIWC route set so an emptied or changed nested router cannot pass silently.
  assert.deepEqual(routes(f.siwcRouter).map(r => `${r.method} ${r.path}`).sort(), [
    'GET /:id', 'GET /accounts', 'GET /accounts/:id/access', 'GET /accounts/:id/routing',
    'POST /:id/cancel', 'POST /:id/finish', 'POST /accounts/:id/access', 'POST /accounts/:id/logout',
    'POST /accounts/:id/routing', 'POST /start',
  ]);
  const nested = prefixes.flatMap(prefix => routes(f.siwcRouter, prefix));
  assert.ok(direct.length > 0 && nested.length === 20);
  const snapshot = direct.find(r=>r.method==='GET' && r.path==='/routing-snapshot');
  assert.ok(snapshot); assert.equal(typeof f.noStore,'function');
  for (const r of direct) {
    const handles = r.route.stack.map(l=>l.handle);
    if (r === snapshot) assert.equal(handles[0], f.noStore);
    assert.equal(handles[r===snapshot?1:0], f.guard, `admin guard ${r.method} ${r.path}`);
  }
  for (const r of [...direct, ...nested]) {
    for (const headers of [{},{authorization:'Bearer synthetic-wrong'}]) {
      const before = f.authCalls;
      const res = await request(f.admin, r.method, urlFor(r.path), headers, ()=>f.authCalls-before);
      assert.equal(f.authCalls-before, 1, `admin auth ${r.method} ${r.path}`);
      assert.equal(res.statusCode, headers.authorization?403:401, `admin status ${r.method} ${r.path}`);
      if (r === snapshot || nested.includes(r)) assert.equal(res.headers['cache-control'],'no-store', `no-store ${r.method} ${r.path}`);
    }
  }
  // The only direct pre-auth middleware: identity above plus capability-limited invocation.
  let next = 0; const sets = [];
  f.noStore(new Proxy({}, {get:forbidden}), {set:(...args)=>{sets.push(args)}}, ()=>next++);
  assert.deepEqual(sets,[['Cache-Control','no-store']]); assert.equal(next,1);
}

async function checkV1(f) {
  const v1Routes = routes(f.v1);
  assert.deepEqual(v1Routes.map(r => `${r.method} ${r.path}`).sort(), ['GET /models', 'POST /chat/completions', 'POST /messages']);
  // The sole non-route layer is the OPTIONS responder; it must pass other methods through untouched.
  const middleware = f.v1.stack.filter(layer => !layer.route);
  assert.equal(middleware.length, 1, 'unexpected v1 middleware');
  let passed = 0;
  middleware[0].handle(new Proxy({method:'GET', url:'/models'}, {set:forbidden}), new Proxy({}, {get:forbidden}), () => passed++);
  assert.equal(passed, 1);
  for (const r of v1Routes) {
    for (const headers of [{}, {authorization:'Bearer synthetic-wrong'}, {'x-api-key':'synthetic-wrong'}]) {
      const before = f.authCalls, downstream = f.downstream;
      const res = await request(f.v1, r.method, urlFor(r.path), headers, ()=>f.authCalls-before);
      assert.equal(f.authCalls-before, 1, `v1 auth ${r.method} ${r.path}`);
      assert.equal(res.statusCode, 401, `v1 status ${r.method} ${r.path}`);
      assert.equal(f.downstream, downstream, `v1 downstream ${r.method} ${r.path}`);
    }
    // Positive control: a valid synthetic key reaches the handler, so the
    // rejections above are not an artifact of a fixture that rejects everything.
    const expected = {'/models':[200, 0], '/chat/completions':[200, 1], '/messages':[501, 0]}[r.path];
    for (const headers of [{authorization:`Bearer ${VALID}`}, {'x-api-key':VALID}]) {
      const before = f.authCalls, downstream = f.downstream;
      const res = await request(f.v1, r.method, urlFor(r.path), headers, ()=>f.authCalls-before);
      assert.equal(f.authCalls-before, 1, `v1 positive auth ${r.method} ${r.path}`);
      assert.equal(res.statusCode, expected[0], `v1 positive ${r.method} ${r.path}`);
      assert.equal(f.downstream, downstream + expected[1], `v1 positive downstream ${r.method} ${r.path}`);
    }
  }
  // OPTIONS is answered without authentication or downstream access.
  const before = f.authCalls, downstream = f.downstream;
  const res = await request(f.v1, 'OPTIONS', '/models', {}, ()=>0, ['allow']);
  assert.equal(res.headers.allow, 'GET,HEAD');
  assert.equal(f.authCalls, before); assert.equal(f.downstream, downstream);
}

const cleanup = f => bounded(f.manager.stopAndDrain(), 2000, 'request drain');
async function checkAll(f) { await checkAdmin(f); await checkV1(f); await cleanup(f); }
// Mutation controls must fail at the named assertion, not for an unrelated reason.
async function expectDetected(f, pattern) {
  try {
    await assert.rejects(checkAll(f), error => {
      assert.ok(error instanceof assert.AssertionError, `expected an assertion failure, got ${error?.message}`);
      assert.match(error.message, pattern);
      return true;
    });
  } finally { await cleanup(f).catch(() => {}); }
}

test('all discovered admin, nested SIWC and v1 routes reject synthetic credentials before dispatch', {timeout:15000}, async()=>{
  await checkAll(fixture());
});
test('removing a v1 endpoint authentication is detected', {timeout:15000}, async()=>{
  await expectDetected(fixture({v1:mutation(/authenticateUserInDispatch\(req, res, \(\) => \{\r?\n\s*if \(!res\.destroyed\) return handler\(req, res\);\r?\n\s*\}, reserveQuota\)/, 'handler(req, res)')}), /v1 auth|before auth/);
});
test('removing a direct admin route guard is detected', {timeout:15000}, async()=>{
  await expectDetected(fixture({admin:mutation("router.get('/stats', authenticateAdmin, ", "router.get('/stats', ")}), /admin guard GET \/stats/);
});
test('removing the nested SIWC guard is detected', {timeout:15000}, async()=>{
  await expectDetected(fixture({siwc:mutation('router.use(noStoreSiwc, authenticateAdmin);', 'router.use(noStoreSiwc);')}), /siwc guard/);
});
test('an unaccounted admin pre-route middleware is detected', {timeout:15000}, async()=>{
  await expectDetected(fixture({admin:mutation('const router = Router();', 'const router = Router();\nrouter.use((_req, _res, next) => next());')}), /unexpected admin middleware/);
});
