import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';

// Only these two real source modules are compiled; no application initialization.
function load(file, dependencies = {}) {
  const source = readFileSync(new URL(`../src/db/${file}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = vm.createContext({ exports, require(name) { if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected import'); return dependencies[name]; }, AbortController, Promise, Error, Map, BigInt, Number, JSON });
  new vm.Script(code, { filename: file }).runInContext(context);
  return exports;
}
const store = load('account-429-v2-store');

function fixture(maliciousOptions = false) {
  const handles = [];
  try {
  const x = new Database(':memory:'); handles.push(x);
  const y = new Database(':memory:'); handles.push(y);
  for (const db of [x, y]) db.transaction(() => { store.provision429V2(db); store.arm429V2(db, 'upstream', 'synthetic', 10); }).immediate();
  let current = x;
  let clock = 0n;
  const requireDb = () => { if (!current || !current.open) throw new Error('Database unavailable synthetic-secret-marker'); return current; };
  // Test-only simulation of the trusted singleton-bound immediate writer.
  const write = (fn, { signal }) => {
    const captured = requireDb();
    return captured.transaction(() => {
      signal.throwIfAborted();
      if (requireDb() !== captured) throw new Error('Singleton changed');
      const value = fn(captured);
      if (requireDb() !== captured) throw new Error('Singleton changed');
      return value;
    }).immediate();
  };
  const { Account429V2Expiry } = load('account-429-v2-expiry', {
    './client.js': { requireInitializedDatabase: requireDb },
    './async-writer.js': { withAsyncWriter: write },
    './account-429-v2-store.js': store,
  });
  const failures = [];
  let maliciousCalls = 0;
  const service = new Account429V2Expiry({ onFailure: error => { failures.push(error); }, readDb: requireDb, write: maliciousOptions ? (fn => { maliciousCalls++; return y.transaction(() => fn(y)).immediate(); }) : write, monotonic: () => clock, setTimer: () => { throw new Error('Unexpected timer'); }, clearTimer: () => {}, intervalMs: 10, maxObservations: 10, scanBatch: 10 });
  let drainAttempted = false;
  return { x, y, service, failures, maliciousCalls: () => maliciousCalls, swap: db => { current = db; }, advance: () => { clock = 10000000n; }, drain: async () => { drainAttempted = true; await service.stopAndDrain(); }, cleanup: async () => { const errors = []; if (!drainAttempted) { try { await service.stopAndDrain(); } catch (e) { errors.push(e); } } for (const db of handles) { try { db.close(); } catch (e) { errors.push(e); } } if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed'); } };
  } catch (primary) {
    const errors = [primary];
    for (const db of handles) { try { db.close(); } catch (e) { errors.push(e); } }
    if (errors.length > 1) throw new AggregateError(errors, 'Fixture setup and cleanup failed');
    throw primary;
  }
}
const count = db => db.prepare('SELECT count(*) AS n FROM account_429_v2_restrictions').get().n;

function assertFailure(failures) {
  assert.equal(failures.length, 1);
  const error = failures[0];
  assert.equal(typeof error, 'object'); assert.notEqual(error, null);
  assert.deepEqual(Object.keys(error), []);
  assert.equal(error.name === 'Error', true, 'Unexpected error name');
  assert.equal(error.message === 'Expiry tick failed', true, 'Unexpected error message');
  assert.equal('cause' in error, false);
  assert.equal(Object.keys(error).some(key => ['name', 'message', 'cause'].includes(key)), false);
  assert.equal(Object.getOwnPropertyNames(error).some(key => String(error[key]).includes('synthetic-secret-marker')), false);
}

async function withFixture(malicious, run) {
  const f = fixture(malicious);
  let failed = false, primary;
  try { await run(f); } catch (e) { failed = true; primary = e; }
  try { await f.cleanup(); } catch (cleanup) {
    if (failed) throw new AggregateError([primary, cleanup], 'Test and cleanup failed');
    throw cleanup;
  }
  if (failed) throw primary;
}

test('singleton swap cannot expire an identical restriction in another database', async () => {
  await withFixture(false, async f => {
    await f.service.tick();
    f.swap(f.y); f.advance();
    await assert.rejects(f.service.tick(), /Expiry tick failed/);
    assertFailure(f.failures);
    assert.equal(count(f.x), 1); assert.equal(count(f.y), 1);
    await assert.rejects(f.service.tick(), /Expiry service unavailable/);
    await assert.rejects(f.drain(), /Expiry service failed/);
    assertFailure(f.failures);
  });
});

test('same singleton expires only after the observed duration', async () => {
  await withFixture(false, async f => {
    await f.service.tick();
    await f.service.tick();
    assert.equal(count(f.x), 1);
    f.advance(); await f.service.tick();
    assert.equal(count(f.x), 0); assert.equal(count(f.y), 1);
    await f.drain();
    assert.equal(f.failures.length, 0, 'Unexpected expiry failure');
  });
});

for (const corruption of ['marker', 'trigger']) test(`unsafe ${corruption} fails closed before expiry deletion`, async () => {
  await withFixture(false, async f => {
    await f.service.tick();
    if (corruption === 'marker') f.x.exec('DELETE FROM account_429_v2_schema_marker');
    else f.x.exec("CREATE TRIGGER malicious BEFORE DELETE ON account_429_v2_restrictions BEGIN DELETE FROM account_429_v2_counter; END");
    f.advance();
    await assert.rejects(f.service.tick(), /Expiry tick failed/);
    assertFailure(f.failures);
    assert.equal(count(f.x), 1); assert.equal(count(f.y), 1);
    await assert.rejects(f.drain(), /Expiry service failed/);
    assertFailure(f.failures);
  });
});

test('caller-supplied mismatched writer cannot redirect deletion', async () => {
  await withFixture(true, async f => {
    await f.service.tick(); f.advance(); await f.service.tick();
    assert.equal(count(f.x), 0); assert.equal(count(f.y), 1);
    await f.drain();
    assert.equal(f.maliciousCalls(), 0);
    assert.equal(f.failures.length, 0, 'Unexpected expiry failure');
  });
});

test('uninitialized singleton fails closed', async () => {
  await withFixture(false, async f => {
    await f.service.tick(); f.swap(null); f.advance();
    await assert.rejects(f.service.tick(), /Expiry tick failed/);
    assertFailure(f.failures);
    assert.equal(count(f.x), 1); assert.equal(count(f.y), 1);
    await assert.rejects(f.drain(), /Expiry service failed/);
    assertFailure(f.failures);
  });
});
