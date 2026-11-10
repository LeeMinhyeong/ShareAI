import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// These are simulated commit/cleanup events, not SQLite fault tests.
let sequence = 0;
async function runCase(mode, uncertain) {
  const secret = 'synthetic-cleanup-secret';
  const state = {mode, rows: [], writers: [], logs: [], calls: 0};
  const shared = {name: 'simulated-file', open: true, inTransaction: false};
  class FakeWriter {
    constructor(path, options) {
      assert.equal(path, shared.name);
      assert.deepEqual(options, {timeout: 0, fileMustExist: true});
      this.isOpen = true; this.inTransaction = false; this.pending = []; this.committed = false;
      state.writers.push(this);
    }
    get open() {
      if (this.committed && state.mode === 'getter-falsey') throw false;
      return this.isOpen;
    }
    pragma(sql) { assert.ok(['foreign_keys = ON', 'synchronous = FULL'].includes(sql)); }
    exec(sql) {
      if (sql === 'BEGIN IMMEDIATE') { assert.equal(this.inTransaction, false); this.inTransaction = true; }
      else if (sql === 'COMMIT') {
        assert.equal(this.inTransaction, true);
        state.rows.push(...this.pending); this.pending = []; this.inTransaction = false; this.committed = true;
      } else if (sql === 'ROLLBACK') { assert.equal(this.inTransaction, true); this.pending = []; this.inTransaction = false; }
      else throw new Error('unexpected statement');
    }
    close() {
      if (state.mode === 'pre-close') throw new Error(secret);
      if (state.mode === 'pre-falsey') throw false;
      if (state.mode === 'silent-open') return;
      this.isOpen = false;
      if (state.mode === 'post-close') throw new Error(secret);
      if (state.mode === 'post-falsey') throw false;
    }
  }
  globalThis.__writerCleanupFixture = {FakeWriter, shared, state};
  const id = ++sequence;
  const fixtureUrl = source => `data:text/javascript,${source}#case-${id}`;
  const hooks = registerHooks({resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/src/db/async-writer.ts')) {
      if (specifier === 'better-sqlite3') return {url:fixtureUrl('export default globalThis.__writerCleanupFixture.FakeWriter'), shortCircuit:true};
      if (specifier === './client.js') return {url:fixtureUrl('export const getDb=()=>globalThis.__writerCleanupFixture.shared;export const requireInitializedDatabase=getDb'), shortCircuit:true};
      if (specifier === '../utils/logger.js') return {url:fixtureUrl('export const logger={error(...args){globalThis.__writerCleanupFixture.state.logs.push(args)}}'), shortCircuit:true};
      throw new Error('unexpected writer dependency');
    }
    return nextResolve(specifier, context);
  }});
  let writerModule, failed = false;
  try {
    writerModule = await import(`../src/db/async-writer.ts?cleanup-case=${id}`);
    const {withAsyncWriter, retryQuarantinedWriters} = writerModule;
    const value = {};
    const result = withAsyncWriter(db => { state.calls++; db.pending.push('committed'); return value; });
    assert.equal(result, value, 'confirmed commit returns the exact value synchronously');
    assert.equal(state.calls, 1);
    assert.deepEqual(state.rows, ['committed']);
    assert.equal(state.writers.length, 1);
    const owned = state.writers[0];
    assert.equal(owned.isOpen, uncertain);
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].length, 1);
    assert.equal(state.logs[0][0] === 'Committed writer cleanup failed', true, 'generic log only');
    assert.equal(JSON.stringify(state.logs).includes(secret), false);
    if (uncertain) {
      let blocked = false;
      try { withAsyncWriter(() => { state.calls++; }); } catch (error) {
        blocked = error instanceof Error && error.message === 'Writer is quarantined';
      }
      assert.equal(blocked, true);
      assert.equal(state.writers.length, 1);
      assert.equal(state.calls, 1);
      let rejected = false;
      try { retryQuarantinedWriters(); } catch (error) {
        rejected = error instanceof Error && error.message === 'Writer quarantine cleanup failed';
      }
      assert.equal(rejected, true, 'failed cleanup must be generic');
      assert.equal(owned.isOpen, true);
      blocked = false;
      try { withAsyncWriter(() => { state.calls++; }); } catch (error) {
        blocked = error instanceof Error && error.message === 'Writer is quarantined';
      }
      assert.equal(blocked, true, 'failed cleanup preserves quarantine');
      assert.equal(state.writers.length, 1);
      assert.equal(state.calls, 1);
      state.mode = 'success';
      retryQuarantinedWriters();
      assert.equal(owned.isOpen, false, 'explicit cleanup closes the owned fake');
      assert.equal(state.calls, 1, 'cleanup never replays the committed operation');
    } else {
      state.mode = 'success';
      assert.equal(owned.isOpen, false);
    }
    // For post-close throws this write must succeed without an explicit retry.
    const recoveryValue = {};
    assert.equal(withAsyncWriter(() => { state.calls++; return recoveryValue; }), recoveryValue);
    assert.equal(state.calls, 2, 'only the explicitly requested new callback runs');
    assert.equal(state.writers.length, 2);
    assert.equal(state.writers[1].isOpen, false);
    assert.deepEqual(state.rows, ['committed']);
  } catch {
    // Do not print fixture-thrown values or assertion diffs containing them.
    failed = true;
  } finally {
    state.mode = 'success';
    try { writerModule?.retryQuarantinedWriters(); } catch { failed = true; }
    hooks.deregister();
    delete globalThis.__writerCleanupFixture;
  }
  assert.equal(failed, false, `simulated ${mode} cleanup case failed`);
}

for (const [mode, uncertain] of [
  ['pre-close', true], ['pre-falsey', true], ['silent-open', true],
  ['getter-falsey', true], ['post-close', false], ['post-falsey', false],
]) {
  test(`confirmed simulated commit survives ${mode} cleanup`, {timeout: 2000}, async () => {
    await runCase(mode, uncertain);
  });
}
