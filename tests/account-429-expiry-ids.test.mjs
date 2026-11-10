import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Database = require('better-sqlite3');

// Only explicitly provided imports are available to the real transpiled modules.
function loadModule(relative, imports) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    alwaysStrict: true,
  }}).outputText;
  const exports = {};
  const localRequire = name => {
    if (!Object.hasOwn(imports, name)) throw new Error('Unexpected module import');
    return imports[name];
  };
  const context = vm.createContext({ exports, require: localRequire, AbortController });
  new vm.Script(`"use strict";\n${compiled}`, { filename: 'fixture-module.js' }).runInContext(context);
  return exports;
}

function check(condition) { assert.ok(condition, 'Expiry ID fixture invariant failed'); }

test('finite restrictions expire for all supported SQLite text IDs', async () => {
  const db = new Database(':memory:');
  let expiry;
  const failures = [];
  let failed = false, primary;
  try {
    const store = loadModule('../src/db/account-429-v2-store.ts', Object.create(null));
    const imports = Object.assign(Object.create(null), {
      './client.js': { requireInitializedDatabase: () => db },
      './async-writer.js': { withAsyncWriter: async callback => db.transaction(() => callback(db)).immediate() },
      './account-429-v2-store.js': store,
    });
    const { Account429V2Expiry } = loadModule('../src/db/account-429-v2-expiry.ts', imports);
    db.transaction(() => store.provision429V2(db)).immediate();
    const ids = ['', '\0leading', 'embedded\0suffix', '\u0001\u001f\u007f', '😀', 'x'.repeat(5000), 'normal'];
    db.transaction(() => { for (const id of ids) store.arm429V2(db, 'upstream', id, 100); }).immediate();
    const count = () => db.prepare('SELECT count(*) AS n FROM main.account_429_v2_restrictions').get().n;
    const row = db.prepare('SELECT CAST(account_id AS BLOB) = CAST(? AS BLOB) AS exact, duration_ms FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?');
    const verifyRows = () => {
      check(count() === ids.length);
      for (const id of ids) {
        const found = row.get(id, 'upstream', id);
        check(!!found && found.exact === 1 && found.duration_ms === 100);
      }
    };
    verifyRows();
    let clock = 0n;
    expiry = new Account429V2Expiry({ onFailure: error => { failures.push(error); }, monotonic: () => clock, setTimer: () => { throw new Error('Unexpected timer'); }, clearTimer: () => {}, intervalMs: 1, maxObservations: 32, scanBatch: 32 });
    const tick = async () => {
      await expiry.tick();
      assert.equal(failures.length, 0, 'Unexpected expiry failure');
    };
    await tick();
    verifyRows();
    clock = 99_000_000n;
    await tick();
    verifyRows();
    clock = 100_000_000n;
    await tick();
    check(count() === 0);
    for (const id of ids) check(row.get(id, 'upstream', id) === undefined);
    await tick();
    check(count() === 0);
  } catch (error) { failed = true; primary = error; }
  const cleanupErrors = [];
  try { if (expiry) await expiry.stopAndDrain(); } catch (error) { cleanupErrors.push(error); }
  try { assert.equal(failures.length, 0, 'Unexpected expiry failure'); } catch (error) { cleanupErrors.push(error); }
  try { db.close(); } catch (error) { cleanupErrors.push(error); }
  if (failed && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], 'Test and cleanup failed');
  if (failed) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed');
});
