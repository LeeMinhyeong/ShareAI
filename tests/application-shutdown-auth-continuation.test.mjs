// Real Express 4 router and production auth, with only storage and transport faked.
// No listeners, filesystem fixtures, credentials, or external services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const express = require('express');
const ts = require('typescript');
function load(path, dependencies = {}, timers = { setTimeout, clearTimeout, Date }) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require,setTimeout,clearTimeout,Date){${compiled}\n})`)(exports, name => {
    if (name === 'node:async_hooks') return require(name);
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, timers.setTimeout, timers.clearTimeout, timers.Date);
  return exports;
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('real Express 4 authentication error continuation precedes shutdown drain', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  const reservation = deferred();
  const user = { id: 'synthetic', name: 'synthetic', email: 'synthetic', tier: 'free', dailyLimit: 1 };
  const logger = { warn() {}, debug() {}, error() {} };
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js': { UserRepository: class {} },
    '../utils/encryption.js': { hashApiKey: () => 'synthetic-hash' },
    '../utils/logger.js': { logger },
    '../config/env.js': { env: {} },
    '../db/async-writer.js': { withAsyncWriter: () => reservation.promise },
    '../request-work.js': { requestWork: manager },
  });
  const route = load('../src/routes/v1.ts', {
    express,
    '../auth/user-auth.js': auth,
    '../upstream/forward-chat.js': { forwardChat() { throw new Error('unexpected route'); } },
    '../request-work.js': { requestWork: manager },
    '../utils/logger.js': { logger },
  }).default;
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/chat/completions', headers: { authorization: 'Bearer synthetic' } });
  const expected = new Error('synthetic response failure');
  const res = Object.assign(new EventEmitter(), { status() { return this; }, json() { throw expected; } });
  let drainFinished = false;
  let observed;
  const continuation = deferred();
  route.handle(req, res, error => { observed = { error, drainFinished }; continuation.resolve(); });
  const drain = manager.stopAndDrain().then(() => { drainFinished = true; });
  reservation.resolve({ allowed: false, used: 1, user });
  await continuation.promise;
  await drain;
  assert.equal(observed.error, expected);
  assert.equal(observed.drainFinished, false, 'drain must wait for Express error continuation');
});

test('SIWC provider flight remains tracked after its sole waiter disconnects', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  const refresh = load('../src/upstream/siwc-refresh.ts', {
    jose: {},
    './siwc-store.js': {},
    '../request-work.js': { requestWork: manager },
  });
  const started = deferred();
  const provider = deferred();
  const bodyRead = deferred();
  const credential = { clientId: 'synthetic-client', refreshToken: 'synthetic-refresh' };
  const snapshot = { revision: 'synthetic-revision', credential };
  const store = {
    db: {},
    refreshConnection() {
      return { store: { claimRefresh() { return { credential }; } }, close() {} };
    },
  };
  const abort = new AbortController();
  const waiter = refresh.refreshSiwcSnapshot(store, 'synthetic-id', snapshot, () => {
    started.resolve();
    return provider.promise;
  }, 10000, abort.signal);
  await started.promise;
  abort.abort(new Error('synthetic disconnect'));
  await assert.rejects(waiter, /synthetic disconnect/);
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  await Promise.resolve();
  await Promise.resolve();
  const premature = drained;
  provider.resolve({ status: 500, json: async () => { bodyRead.resolve(); return {}; } });
  await bodyRead.promise;
  await drain;
  assert.equal(premature, false, 'drain must wait for the independent SIWC flight');
});

test('SIWC timeout keeps the inner operation tracked until late transport settles', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  let timeout, timeoutMs, now = Date.now();
  const timers = {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { if (ms > 14000) { timeout = fn; timeoutMs = ms; return { synthetic: true }; } return setTimeout(fn, ms); },
    clearTimeout(id) { if (!id?.synthetic) clearTimeout(id); },
  };
  const refresh = load('../src/upstream/siwc-refresh.ts', { jose: {}, './siwc-store.js': {}, '../request-work.js': { requestWork: manager } }, timers);
  const started = deferred(), provider = deferred(), bodyRead = deferred();
  const credential = { clientId: 'synthetic-client', refreshToken: 'synthetic-refresh' };
  const snapshot = { revision: 'synthetic-revision', credential };
  let writes = 0;
  const store = { db: {}, refreshConnection() { return { store: { claimRefresh() { return { credential }; }, finishRefresh() { writes++; } }, close() {} }; } };
  const abort = new AbortController();
  const waiter = refresh.refreshSiwcSnapshot(store, 'synthetic-id', snapshot, () => { started.resolve(); return provider.promise; }, 10000, abort.signal);
  await started.promise;
  abort.abort(new Error('synthetic disconnect'));
  await assert.rejects(waiter, /synthetic disconnect/);
  let drained = false;
  const drain = manager.stopAndDrain().then(() => { drained = true; });
  assert.equal(typeof timeout, 'function');
  assert.equal(timeoutMs, 15000);
  now += timeoutMs;
  timeout();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const premature = drained;
  provider.resolve({ status: 500, json: async () => { bodyRead.resolve(); return {}; } });
  await bodyRead.promise;
  await drain;
  assert.equal(premature, false, 'timeout must not release a still-running inner operation');
  assert.equal(writes, 0);
});

test('shutdown rejects a new SIWC root even when a matching flight exists', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  const refresh = load('../src/upstream/siwc-refresh.ts', { jose: {}, './siwc-store.js': {}, '../request-work.js': { requestWork: manager } });
  const started = deferred(), provider = deferred();
  const credential = { clientId: 'synthetic-client', refreshToken: 'synthetic-refresh' };
  const snapshot = { revision: 'synthetic-revision', credential };
  const store = { db: {}, refreshConnection() { return { store: { claimRefresh() { return { credential }; } }, close() {} }; } };
  const abort = new AbortController();
  let calls = 0;
  const fetcher = () => { calls++; started.resolve(); return provider.promise; };
  const first = refresh.refreshSiwcSnapshot(store, 'synthetic-id', snapshot, fetcher, 10000, abort.signal);
  await started.promise;
  const drain = manager.stopAndDrain();
  const secondAbort = new AbortController();
  const second = refresh.refreshSiwcSnapshot(store, 'synthetic-id', snapshot, fetcher, 10000, secondAbort.signal);
  let outcome;
  void second.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const admissionOutcome = outcome;
  secondAbort.abort(); abort.abort();
  await Promise.allSettled([first, second]);
  provider.resolve({ status: 500, json: async () => ({}) });
  await drain;
  assert.equal(admissionOutcome, 'rejected', 'new roots must not attach after admission closes');
  assert.equal(calls, 1);
});

test('coalesced SIWC waiters complete with one provider dispatch', async () => {
  const manager = new (load('../src/request-work.ts').RequestWorkManager)();
  const refresh = load('../src/upstream/siwc-refresh.ts', { jose: {}, './siwc-store.js': {}, '../request-work.js': { requestWork: manager } });
  const provider = deferred(), started = deferred();
  const credential = { clientId: 'synthetic-client', refreshToken: 'synthetic-old' };
  const snapshot = { revision: 'old', credential };
  let current = snapshot, claims = 0, calls = 0;
  const store = { db: {}, refreshConnection() { return { store: {
    claimRefresh() { claims++; return { credential }; },
    finishRefresh(_id, _intent, next) { current = { revision: 'new', credential: next }; return current; },
    readSnapshot() { return current; },
  }, close() {} }; } };
  const fetcher = () => { calls++; started.resolve(); return provider.promise; };
  const first = refresh.refreshSiwcSnapshot(store, 'synthetic-id', snapshot, fetcher, 10000);
  const second = refresh.refreshSiwcSnapshot(store, 'synthetic-id', snapshot, fetcher, 10000);
  await started.promise;
  const drain = manager.stopAndDrain();
  provider.resolve({ status: 200, json: async () => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-new', token_type: 'Bearer', expires_in: 3600 }) });
  const results = await Promise.all([first, second]);
  await drain;
  assert.equal(calls, 1);
  assert.equal(claims, 1);
  assert.equal(results[0].revision, 'new');
  assert.deepEqual(results[1], results[0]);
});
