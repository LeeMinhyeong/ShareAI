// Real Express dispatch on synthetic request/response objects; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../src/request-work.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, require);
const turn = () => new Promise(setImmediate);

test('Express error path retains a registered task scheduled before throwing', async () => {
  const manager = new exports.ControlledIngress();
  const router = require('express').Router();
  let release, task, errorReached = false, child;
  const gate = new Promise(resolve => { release = resolve; });
  router.use((_req, _res, next) => manager.ingress(next));
  router.use(() => {
    task = manager.run(async () => {
      await gate;
      child = manager.run(() => 'child');
      assert.equal(await child, 'child');
    });
    throw new Error('synthetic');
  });
  router.use((err, _req, _res, _next) => {
    errorReached = err.message === 'synthetic';
    manager.terminal();
  });
  router.handle({ method: 'GET', url: '/' }, {}, () => {});
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  assert.equal(errorReached, true);
  await turn();
  assert.equal(drained, false);
  release();
  await task;
  await drain;
  assert.equal(drained, true);
});

test('async Express errors reach a terminal error handler without relying on next return', async () => {
  const manager = new exports.ControlledIngress();
  const router = require('express').Router();
  let seen = false;
  router.use((_req, _res, next) => manager.ingress(next));
  router.use((_req, _res, next) => { setImmediate(() => next(new Error('synthetic'))); });
  router.use((error, _req, _res, _next) => {
    seen = error.message === 'synthetic';
    manager.terminal();
  });
  router.handle({ method: 'GET', url: '/' }, {}, () => {});
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  assert.equal(drained, false);
  await drain;
  assert.equal(seen, true);
});

test('default dispatch-out explicitly terminates ingress', async () => {
  const manager = new exports.ControlledIngress();
  const router = require('express').Router();
  let out = false;
  router.use((_req, _res, next) => manager.ingress(next));
  for (let i = 0; i < 120; i++) router.use((_req, _res, next) => next());
  router.handle({ method: 'GET', url: '/' }, {}, () => { out = true; manager.terminal(); });
  await manager.stopAndDrain();
  assert.equal(out, true);
});

test('dispatch that schedules then throws stays owned until its real terminal', async () => {
  const manager = new exports.ControlledIngress();
  let finish, continuation;
  const gate = new Promise(resolve => { finish = resolve; });
  assert.throws(() => manager.ingress(() => {
    continuation = gate.then(() => manager.terminal());
    throw new Error('synthetic');
  }), /synthetic/);
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  finish();
  assert.equal(await continuation, true);
  await drain;
  assert.equal(drained, true);
});

test('audited synchronous failure can mark terminal and drain', async () => {
  const manager = new exports.ControlledIngress();
  manager.ingress(() => {
    try { throw new Error('synchronous and no scheduling'); }
    catch { assert.equal(manager.terminal(), true); }
  });
  await manager.stopAndDrain();
});

test('a stale child context cannot admit work after its token settles', async () => {
  const manager = new exports.ControlledIngress();
  let replay, task, trigger;
  const gate = new Promise(resolve => { trigger = resolve; });
  manager.ingress(() => {
    task = manager.run(() => { replay = gate.then(() => manager.run(() => 'unauthorized')); });
    manager.terminal();
  });
  await task;
  await manager.stopAndDrain();
  trigger();
  assert.equal(await replay, undefined);
});
