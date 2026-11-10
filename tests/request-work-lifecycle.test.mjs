// Synthetic lifecycle tests; no sockets, storage, or provider calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(path, deps = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const out = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(out, name => name === 'node:async_hooks' ? require(name) : deps[name] ?? (() => { throw Error(name); })());
  return out;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('closed admission permits active descendants but never replays a settled context', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  const start = deferred(), childGate = deferred(); let child, replay;
  const root = manager.run(async () => {
    await start.promise;
    child = manager.run(() => childGate.promise);
    setImmediate(() => { replay = manager.run(() => 'replayed'); });
  });
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  assert.equal(manager.run(() => 'new root'), undefined);
  start.resolve(); await root;
  assert.ok(child, 'active parent must admit child after stop');
  await new Promise(setImmediate);
  assert.equal(replay, undefined, 'settled parent context must not be reusable');
  assert.equal(drained, false);
  childGate.resolve(); await child; await drain;
});

test('claimed nested handoffs cannot authorize a replay', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  const gate = deferred(), request = {}, childGate = deferred(); let child;
  const root = manager.run(async () => {
    await gate.promise;
    manager.handoff(request, () => {
      void manager.run(() => manager.handoff(request, () => {
        child = manager.run(() => childGate.promise, request);
      }), request);
    });
  });
  const drain = manager.stopAndDrain();
  gate.resolve(); await root;
  assert.ok(child);
  assert.equal(manager.run(() => {}, request), undefined);
  childGate.resolve(); await drain;
});
