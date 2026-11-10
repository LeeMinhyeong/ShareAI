// Isolated Express router: no sockets, configuration, or database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/request-work.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, require);
const turn = () => new Promise(setImmediate);

test('Express deferred dispatch remains owned; request identity cannot authorize another root', async () => {
  const manager = new exports.ControlledIngress();
  const router = require('express').Router();
  const req = { method: 'GET', url: '/' }, res = {};
  let task, entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  router.use((_req, _res, next) => manager.ingress(next));
  for (let i = 0; i < 120; i++) router.use((_req, _res, next) => next());
  router.use(() => {
    task = manager.run(async () => { entered = true; await gate; });
    manager.terminal();
  });
  router.handle(req, res, () => {});
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  assert.equal(manager.run(() => 'unrelated', req), undefined);
  await turn();
  assert.equal(entered, true);
  assert.equal(drained, false);
  release();
  await task;
  await drain;
  assert.equal(drained, true);
});
