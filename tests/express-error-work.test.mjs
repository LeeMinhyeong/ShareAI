import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
const require = createRequire(import.meta.url), express = require('express'), ts = require('typescript');
function load(path, deps = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, name => name === 'node:async_hooks' ? require(name) : deps[name]);
  return exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(failure) {
  const workModule = load('../src/request-work.ts');
  const manager = new workModule.RequestWorkManager(), reservation = deferred();
  const logger = { warn() {}, debug() {}, error() {} };
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js': { UserRepository: class {} }, '../utils/encryption.js': { hashApiKey: () => 'hash' },
    '../utils/logger.js': { logger }, '../config/env.js': { env: {} },
    '../db/async-writer.js': { withAsyncWriter: () => reservation.promise }, '../request-work.js': { requestWork: manager },
  });
  const router = express.Router(), started = deferred(), release = deferred();
  let routes = 0, errors = [], ended = false;
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/', headers: { authorization: 'Bearer synthetic' } });
  const res = Object.assign(new EventEmitter(), { status() { return this; }, json() { if (!ended) { ended = true; throw failure; } }, destroy() { this.destroyed = true; } });
  router.post('/', auth.authenticateUser, () => { routes++; });
  const handler = async (err, _req, _res, _next) => { errors.push(err); started.resolve(); await release.promise; };
  router.use(workModule.trackedErrorHandler ? workModule.trackedErrorHandler(handler, manager) : handler);
  router.handle(req, res, () => {});
  return { manager, reservation, started, release, get routes() { return routes; }, errors };
}

test('Express 4 pending error middleware remains a child during shutdown', async () => {
  const f = setup(new Error('synthetic'));
  let drained = false;
  const drain = f.manager.stopAndDrain().then(() => { drained = true; });
  f.reservation.resolve({ allowed: false, used: 1, user: { id: 'x', dailyLimit: 1 } });
  await f.started.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const premature = drained;
  f.release.resolve(); await drain;
  assert.equal(premature, false);
  assert.equal(f.routes, 0);
});

test('non-Error authentication failures enter error middleware, never the route', async () => {
  for (const failure of [undefined, null, false, 0, '', 'route', 'router', 'failure']) {
    const f = setup(failure);
    f.reservation.resolve({ allowed: false, used: 1, user: { id: 'x', dailyLimit: 1 } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    f.release.resolve();
    assert.equal(f.routes, 0);
    assert.equal(f.errors.length, 1);
    assert.ok(f.errors[0] instanceof Error);
    await f.manager.stopAndDrain();
  }
});

test('an asynchronous error handler can hand off to another during shutdown', async () => {
  const { RequestWorkManager, trackedErrorHandler } = load('../src/request-work.ts');
  const manager = new RequestWorkManager(), first = deferred(), second = deferred();
  const router = express.Router();
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/' });
  const res = Object.assign(new EventEmitter(), { status() { return this; }, json() {} });
  let reached = false;
  router.get('/', (_req, _res, next) => { void manager.run(() => manager.handoff(req, () => next(new Error('first')))); });
  router.use(trackedErrorHandler(async (_err, _req, _res, next) => { await first.promise; next(new Error('second')); }, manager));
  router.use(trackedErrorHandler(async () => { reached = true; await second.promise; }, manager));
  router.handle(req, res, () => {});
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  first.resolve();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const premature = drained;
  second.resolve(); await drain;
  assert.equal(reached, true);
  assert.equal(premature, false);
});

test('rejected async error middleware is contained without leaking or redispatching', async () => {
  for (const sent of [false, true]) {
    const { RequestWorkManager, trackedErrorHandler } = load('../src/request-work.ts');
    const manager = new RequestWorkManager(), release = deferred(), started = deferred();
    const router = express.Router();
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/' });
    let body, status, destroyed = 0, dispatches = 0, routes = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: sent, status(n) { status = n; return this; }, json(v) { body = v; }, destroy() { destroyed++; } });
    router.get('/', (_req, _res, next) => { void manager.run(() => manager.handoff(req, () => next(new Error('input')))); }, () => { routes++; });
    router.use(trackedErrorHandler(async () => { dispatches++; started.resolve(); await release.promise; throw new Error('secret-marker'); }, manager));
    router.use((_err, _req, _res, _next) => { dispatches++; });
    router.handle(req, res, () => { dispatches++; });
    await started.promise;
    let drained = false; const drain = manager.stopAndDrain().then(() => { drained = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const premature = drained; release.resolve(); await drain;
    assert.equal(premature, false);
    assert.equal(dispatches, 1); assert.equal(routes, 0);
    assert.equal(destroyed, sent ? 1 : 0);
    if (!sent) { assert.equal(status, 500); assert.deepEqual(body, { error: { type: 'internal_error', message: 'Internal server error.' } }); }
    assert.equal(JSON.stringify(body ?? '').includes('secret-marker'), false);
  }
});
