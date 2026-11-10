// Real Express 4 router; in-memory request/response and synthetic dependencies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript'), express = require('express');
function load(path, deps = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${source}\n})`)(exports, name => name === 'node:async_hooks' ? require(name) : name in deps ? deps[name] : (()=>{throw Error('unexpected dependency')})());
  return exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
const logger = {info(){},error(){},warn(){},debug(){}};
async function exerciseDeferredError(stopBeforeDispatch, closeBeforeDispatch = false) {
  const work = load('../src/request-work.ts');
  const manager = new work.RequestWorkManager();
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js': {UserRepository: class {}}, '../utils/encryption.js': {hashApiKey: ()=>'synthetic'},
    '../utils/logger.js': {logger}, '../config/env.js': {env:{}}, '../db/async-writer.js': {withAsyncWriter(){throw Error('unexpected')}}, '../request-work.js': {requestWork: manager}
  });
  const router = express.Router();
  const gate = deferred(), entered = deferred(); let drained = false;
  router.get('/x', auth.authenticateUser, ...Array.from({length: 120},()=> (_req,_res,next)=>next()), ()=>assert.fail('authentication bypassed'));
  router.use(work.trackedErrorHandler(async (_err,_req,_res,_next)=>{entered.resolve(); await gate.promise;}, manager));
  const req = {method:'GET', url:'/x', headers:{}};
  const res = Object.assign(new EventEmitter(), {destroyed:false, writableEnded:false, headersSent:false, status(){throw Error('synthetic response error')}, destroy(){this.destroyed=true}});
  router.handle(req, res, ()=>{});
  let drain;
  if (stopBeforeDispatch) drain = manager.stopAndDrain().then(()=>{drained=true});
  if (closeBeforeDispatch) { res.destroyed = true; res.emit('close'); }
  try {
    if (drain) { await Promise.resolve(); assert.equal(drained, false, 'pending handoff must survive stop and socket close'); }
    let timer;
    try { await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('deferred error handler was not admitted')), 500); })]); }
    finally { clearTimeout(timer); }
    if (!drain) drain = manager.stopAndDrain().then(()=>{drained=true});
    assert.equal(drained, false, 'drain must retain the deferred error handler promise');
  } finally { gate.resolve(); await drain; }
}
test('positive control: deferred error handler runs and stays tracked before drain', {timeout: 2000}, () => exerciseDeferredError(false));
test('real Express deferred error dispatch remains owned during drain', {timeout: 2000}, () => exerciseDeferredError(true));
test('closed socket does not release a deferred Express error handoff', {timeout: 2000}, () => exerciseDeferredError(true, true));

test('async auth and real tracked route remain owned across deferred dispatch and response finish', {timeout: 2000}, async () => {
  const work = load('../src/request-work.ts'), manager = new work.RequestWorkManager();
  const quota = deferred(), entered = deferred(), release = deferred();
  const user = {id:'u', name:'u', email:'u', tier:'free', dailyLimit:10};
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js': {UserRepository: class {}}, '../utils/encryption.js': {hashApiKey: () => 'hash'},
    '../utils/logger.js': {logger}, '../config/env.js': {env:{}},
    '../db/async-writer.js': {withAsyncWriter: () => quota.promise}, '../request-work.js': {requestWork: manager}
  });
  const routes = load('../src/routes/v1.ts', {
    express, '../auth/user-auth.js': auth, '../request-work.js': {requestWork: manager}, '../utils/logger.js': {logger},
    '../upstream/forward-chat.js': {forwardChat: async (_req, res) => { res.writableEnded = true; res.emit('finish'); entered.resolve(); await release.promise; }}
  }).default;
  const route = routes.stack.find(layer => layer.route?.path === '/chat/completions').route.stack[1].handle;
  const router = express.Router();
  router.post('/x', auth.authenticateUser, ...Array.from({length:120}, () => (_req,_res,next) => next()), route);
  const req = {method:'POST', url:'/x', headers:{authorization:'Bearer synthetic'}};
  const res = Object.assign(new EventEmitter(), {destroyed:false, writableEnded:false});
  router.handle(req, res, () => {});
  let drained = false;
  const drain = manager.stopAndDrain().then(() => {drained = true});
  quota.resolve({allowed:true, user});
  let timer;
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('route not admitted')), 500); })]);
    await Promise.resolve();
    assert.equal(drained, false);
    assert.deepEqual(req.user, user);
  } finally { clearTimeout(timer); release.resolve(); }
  await drain;
});

test('production v1 dispatch cannot be claimed by unrelated work on the same request', {timeout: 2000}, async () => {
  const work = load('../src/request-work.ts'), manager = new work.RequestWorkManager();
  const quota = deferred(), entered = deferred(), release = deferred();
  const user = {id:'u', name:'u', email:'u', tier:'free', dailyLimit:10};
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js': {UserRepository: class {}},
    '../utils/encryption.js': {hashApiKey: () => 'hash'},
    '../utils/logger.js': {logger}, '../config/env.js': {env:{}},
    '../db/async-writer.js': {withAsyncWriter: () => quota.promise}, '../request-work.js': {requestWork: manager}
  });
  const routes = load('../src/routes/v1.ts', {
    express, '../auth/user-auth.js': auth, '../request-work.js': {requestWork: manager}, '../utils/logger.js': {logger},
    '../upstream/forward-chat.js': {forwardChat: async (req, res) => {
      assert.deepEqual(req.user, user);
      res.writableEnded = true;
      entered.resolve();
      await release.promise;
    }}
  }).default;
  const stack = routes.stack.find(layer => layer.route?.path === '/chat/completions').route.stack;
  const extra = express.Router();
  let unrelated;
  extra.use((req, _res, next) => { unrelated = manager.run(() => 'unrelated', req); next(); });
  for (let i = 0; i < 120; i++) extra.use((_req, _res, next) => next());
  stack.splice(1, 0, ...extra.stack);
  const req = {method:'POST', url:'/chat/completions', headers:{authorization:'Bearer synthetic'}};
  const res = Object.assign(new EventEmitter(), {
    destroyed:false, writableEnded:false, headersSent:false,
    status() { return this; }, json() { this.writableEnded = true; return this; },
    destroy() { this.destroyed = true; }
  });
  routes.handle(req, res, () => {});
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  quota.resolve({allowed:true, user});
  let timer;
  try {
    await Promise.race([entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('production route not admitted')), 500); })]);
    assert.equal(unrelated, undefined, 'request identity must not transfer dispatch ownership');
    assert.equal(drained, false, 'response completion must not release the route promise');
  } finally { clearTimeout(timer); release.resolve(); }
  await drain;
});

test('an unrelated continuation inheriting dispatch context cannot claim its lease', {timeout: 2000}, async () => {
  const {RequestWorkManager} = load('../src/request-work.ts');
  const manager = new RequestWorkManager();
  const ready = deferred(), resume = deferred();
  let unrelated;
  const root = manager.run(() => manager.handoff({}, () => {
    setImmediate(async () => {
      unrelated = manager.runDispatch(() => 'unrelated');
      ready.resolve();
      await resume.promise;
    });
  }));
  const drain = manager.stopAndDrain();
  await ready.promise;
  try { assert.equal(unrelated, undefined, 'inherited async context is not proof of actual router dispatch'); }
  finally { resume.resolve(); if (unrelated) await unrelated; await root; }
  // An unclaimed handoff is deliberately retained: it is not safe to drain.
  void drain;
});
