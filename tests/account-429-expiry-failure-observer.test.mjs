import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';

// Load only the staged modules and a deterministic writer bound to this fixture.
function fixture({ writerFailure, timerFailureAt, clearFailure = false, abortFailure = false, onFailure = () => {}, waitForAbort = false, pendingWriter } = {}) {
  const db = new Database(':memory:');
  let callback, timerCalls = 0, writes = 0;
  class FixtureAbortController extends AbortController {
    abort(reason) {
      super.abort(reason);
      if (abortFailure) throw new Error('synthetic-secret-abort');
    }
  }
  const context = vm.createContext({ AbortController: FixtureAbortController, Error, Promise, Map, BigInt, Number, JSON });
  function load(relative, modules) {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8');
    const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    const require = name => {
      if (!Object.hasOwn(modules, name)) throw new Error('Unexpected import: ' + name);
      return modules[name];
    };
    vm.runInContext('(function(exports, require) { "use strict";\n' + code + '\n})', context)(exports, require);
    return exports;
  }
  const store = load('../src/db/account-429-v2-store.ts', {});
  db.transaction(() => store.provision429V2(db)).immediate();
  const writer = async (fn, { signal }) => {
    writes++;
    if (signal.aborted) throw signal.reason;
    if (pendingWriter) return await pendingWriter(signal);
    if (waitForAbort) return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (writerFailure) throw new Error('synthetic-secret-account-db-credential');
    return db.transaction(() => fn(db)).immediate();
  };
  const { Account429V2Expiry } = load('../src/db/account-429-v2-expiry.ts', {
    './client.js': { requireInitializedDatabase: () => db },
    './async-writer.js': { withAsyncWriter: writer },
    './account-429-v2-store.js': store,
  });
  const service = new Account429V2Expiry({
    monotonic: () => 0n, intervalMs: 10, maxObservations: 4, scanBatch: 4, onFailure,
    setTimer(fn) { if (++timerCalls === timerFailureAt) throw new Error('synthetic-secret-timer'); callback = fn; return timerCalls; },
    clearTimer() { callback = undefined; if (clearFailure) throw new Error('synthetic-secret-clear'); },
  });
  return { db, service, fire: () => { const fn = callback; callback = undefined; assert.ok(fn); fn(); }, writes: () => writes };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('automatic writer failure immediately notifies once with sanitized error', async () => {
  const errors = [];
  const f = fixture({ writerFailure: true, onFailure: e => errors.push(e) });
  try {
    f.service.start(); f.fire(); await flush();
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(errors[0].message, 'Expiry tick failed');
    assert.doesNotMatch(String(errors[0].stack), /synthetic-secret/);
    await assert.rejects(f.service.tick(), /Expiry service unavailable/);
    await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
    assert.equal(errors.length, 1);
  } finally { f.db.close(); }
});

test('automatic schema failure is observed without leaking SQLite details', async () => {
  const errors = [];
  const f = fixture({ onFailure: e => errors.push(e) });
  try {
    f.db.exec('DROP TABLE account_429_v2_counter');
    f.service.start(); f.fire(); await flush();
    assert.equal(f.writes(), 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Expiry tick failed');
    assert.doesNotMatch(errors[0].stack, /account_429|SQLITE|credential/i);
    await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
  } finally { f.db.close(); }
});

test('later timer scheduling failure is reported after a successful tick', async () => {
  const errors = [];
  const f = fixture({ timerFailureAt: 2, onFailure: e => errors.push(e) });
  try {
    f.service.start(); f.fire(); await flush();
    assert.equal(f.writes(), 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Expiry timer failed');
    assert.doesNotMatch(errors[0].stack, /synthetic-secret/);
    await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
    assert.equal(errors.length, 1);
  } finally { f.db.close(); }
});

test('start scheduling failure notifies synchronously before throwing', async () => {
  const errors = [];
  const f = fixture({ timerFailureAt: 1, onFailure: e => errors.push(e) });
  try {
    assert.throws(() => f.service.start(), /Expiry timer failed/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Expiry timer failed');
    assert.doesNotMatch(errors[0].stack, /synthetic-secret/);
    await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
  } finally { f.db.close(); }
});

test('observer throws or rejects without unhandled rejection', async () => {
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    for (const observer of [
      () => { throw new Error('observer'); },
      async () => { throw new Error('observer'); },
      () => Object.defineProperty({}, 'then', { get() { throw new Error('observer'); } }),
      () => ({ then(_resolve, reject) { reject(new Error('observer')); reject(new Error('observer again')); throw new Error('observer late'); } }),
    ]) {
      let calls = 0;
      const f = fixture({ writerFailure: true, onFailure: () => { calls++; return observer(); } });
      try {
        f.service.start(); f.fire(); await flush();
        await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
        await flush();
        assert.equal(calls, 1);
      } finally { f.db.close(); }
    }
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', listener); }
});

test('explicit tick rejects deterministically and drain retains failure', async () => {
  const errors = [];
  const f = fixture({ writerFailure: true, onFailure: e => errors.push(e) });
  try {
    await assert.rejects(f.service.tick(), { message: 'Expiry tick failed' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Expiry tick failed');
    await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
  } finally { f.db.close(); }
});

test('normal stop aborts a pending writer without alerting', async () => {
  const errors = [];
  const f = fixture({ waitForAbort: true, onFailure: e => errors.push(e) });
  try {
    f.service.start(); f.fire(); await flush();
    assert.equal(f.writes(), 1);
    await f.service.stopAndDrain(); await flush();
    assert.equal(errors.length, 0);
  } finally { f.db.close(); }
});

test('stop cleanup failures notify once, sanitize and permit synchronous reentry', async () => {
  for (const failure of [{ clearFailure: true }, { abortFailure: true }, { clearFailure: true, abortFailure: true }]) {
    const errors = [], drains = [], ticks = [], starts = [];
    let f;
    f = fixture({ ...failure, onFailure(error) {
      errors.push(error);
      const drain = f.service.stopAndDrain(); drains.push(drain); drain.catch(() => {});
      const tick = f.service.tick(); ticks.push(tick); tick.catch(() => {});
      try { f.service.start(); starts.push(null); } catch (e) { starts.push(e); }
    } });
    try {
      f.service.start();
      const drain = f.service.stopAndDrain();
      await assert.rejects(drain, { message: 'Expiry service failed' });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, 'Expiry service failed');
      assert.doesNotMatch(errors[0].stack, /synthetic-secret/);
      assert.equal(drains[0], drain);
      assert.equal(f.service.stopAndDrain(), drain);
      await assert.rejects(ticks[0], /Expiry service unavailable/);
      assert.equal(starts[0]?.message, 'Expiry service unavailable');
    } finally { f.db.close(); }
  }
});

test('tick and timer failure observers can synchronously reenter lifecycle methods', async () => {
  for (const scenario of ['writer', 'initial timer', 'later timer']) {
    const errors = [], drains = [], ticks = [], starts = [];
    let f;
    f = fixture({ writerFailure: scenario === 'writer', timerFailureAt: scenario === 'initial timer' ? 1 : scenario === 'later timer' ? 2 : undefined,
      onFailure(error) {
        errors.push(error);
        const drain = f.service.stopAndDrain(); drains.push(drain); drain.catch(() => {});
        const tick = f.service.tick(); ticks.push(tick); tick.catch(() => {});
        try { f.service.start(); starts.push(null); } catch (e) { starts.push(e); }
      } });
    try {
      if (scenario === 'initial timer') assert.throws(() => f.service.start(), /Expiry timer failed/);
      else { f.service.start(); f.fire(); await flush(); }
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, scenario === 'writer' ? 'Expiry tick failed' : 'Expiry timer failed');
      assert.doesNotMatch(errors[0].stack, /synthetic-secret/);
      assert.equal(f.service.stopAndDrain(), drains[0]);
      await assert.rejects(drains[0], /Expiry service failed/);
      await assert.rejects(ticks[0], /Expiry (tick failed|service unavailable)/);
      assert.equal(starts[0]?.message, 'Expiry service unavailable');
    } finally { f.db.close(); }
  }
});

test('stop cancellation does not mask cleanup failure', async () => {
  const errors = [];
  const f = fixture({ waitForAbort: true, clearFailure: true, onFailure: e => errors.push(e) });
  try {
    f.service.start();
    const tick = f.service.tick();
    await flush();
    assert.equal(f.writes(), 1);
    const drain = f.service.stopAndDrain();
    await tick;
    await assert.rejects(drain, /Expiry service failed/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Expiry service failed');
  } finally { f.db.close(); }
});

test('pending writer failure wins over cleanup failure and permits observer reentry', async () => {
  let rejectWriter, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const errors = [], drains = [], ticks = [], starts = [];
  let f;
  f = fixture({ clearFailure: true, pendingWriter: () => new Promise((_resolve, reject) => { rejectWriter = reject; entered(); }), onFailure(error) {
    errors.push(error);
    const drain = f.service.stopAndDrain(); drains.push(drain); drain.catch(() => {});
    const tick = f.service.tick(); ticks.push(tick); tick.catch(() => {});
    try { f.service.start(); starts.push(null); } catch (e) { starts.push(e); }
  } });
  try {
    f.service.start();
    const tick = f.service.tick(); tick.catch(() => {});
    await ready;
    const drain = f.service.stopAndDrain(); drain.catch(() => {});
    rejectWriter(new Error('synthetic-secret-writer'));
    await assert.rejects(tick, { message: 'Expiry tick failed' });
    await assert.rejects(drain, { message: 'Expiry service failed' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Expiry tick failed');
    assert.doesNotMatch(errors[0].stack, /synthetic-secret/);
    assert.equal(drains[0], drain);
    await assert.rejects(ticks[0], /Expiry tick failed/);
    assert.equal(starts[0]?.message, 'Expiry service unavailable');
  } finally { f.db.close(); }
});
