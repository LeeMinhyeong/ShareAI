// Real Express dispatch; synthetic request/response only, no sockets or storage.
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

test('a throwing next that already scheduled real Express dispatch keeps ownership', { timeout: 2000 }, async () => {
  const manager = new exports.RequestWorkManager();
  const router = require('express').Router();
  const req = { method: 'GET', url: '/' }, res = {};
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatched = new Promise(resolve => { reached = resolve; });
  router.use(() => reached());
  const root = manager.run(() => manager.handoff(req, () => {
    void gate.then(() => router.handle(req, res, () => reached()));
    throw new Error('synthetic');
  }));
  await assert.rejects(root, /synthetic/);
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve();
  try {
    assert.equal(drained, false, 'throwing does not prove the scheduled Express dispatch was cancelled');
  } finally {
    release();
    await dispatched;
    void drain;
  }
});
