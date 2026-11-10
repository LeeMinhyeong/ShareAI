// Real Express routing, synthetic request/response; no sockets or database.
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

test('an unrelated same-request dispatch cannot steal an Express-deferred continuation', async () => {
  const manager = new exports.RequestWorkManager();
  const router = require('express').Router();
  const req = { method: 'GET', url: '/' }, res = {};
  let root, downstream, entered = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  router.use((_req, _res, next) => { root = manager.run(() => manager.handoff(req, next)); });
  for (let i = 0; i < 120; i++) router.use((_req, _res, next) => next());
  router.use((_req, _res, _next) => { downstream = manager.run(() => { entered = true; return gate; }, req); });
  router.handle(req, res, () => {});
  const drained = manager.stopAndDrain();
  const unrelated = manager.run(() => 'unauthorized', req);
  await new Promise(setImmediate);
  release();
  await root;
  if (downstream) await downstream;
  if (unrelated) await unrelated;
  await drained;
  assert.equal(unrelated, undefined, 'request identity alone must not authorize a new dispatch');
  assert.equal(entered, true, 'the authentic deferred continuation remains admitted');
});

test('an unproven synchronous next throw conservatively retains its handoff', { timeout: 2000 }, async () => {
  const manager = new exports.RequestWorkManager();
  const root = manager.run(() => manager.handoff({}, () => { throw new Error('synthetic'); }));
  await assert.rejects(root, /synthetic/);
  let drained = false;
  void manager.stopAndDrain().then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(drained, false, 'a throwing callback may already have scheduled a continuation');
});
