// Synthetic manager regression; no sockets, database or services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const code = ts.transpileModule(readFileSync(new URL('../src/request-work.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, require);
test('an unrelated inherited continuation cannot start work after shutdown', { timeout: 2000 }, async () => {
  const manager = new exports.RequestWorkManager();
  let release, unrelated;
  const gate = new Promise(resolve => { release = resolve; });
  const root = manager.run(() => gate.then(() => { unrelated = manager.run(() => 'unrelated'); }));
  const drain = manager.stopAndDrain();
  release();
  await root;
  if (unrelated) await unrelated;
  await drain;
  assert.equal(unrelated, undefined);
});
