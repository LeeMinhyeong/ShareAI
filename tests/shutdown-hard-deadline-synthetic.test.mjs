// Executes the production server module in a VM with synthetic dependencies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function fixture({ throwInfo = false, throwError = false, throwConnections = false, throwOAuth = false, rejectOAuth = false, throwDatabase = false, pending = true, closeError = null } = {}) {
  const events = [], signals = {}, timers = [];
  let startup, initCalls=0, expiryStarts=0, expiryStops=0, starting=true;
  const never = new Promise(() => {});
  const done = pending ? never : Promise.resolve();
  const server = {
    on() {},
    close(callback) { events.push('close'); if (!pending) callback(closeError); },
    closeAllConnections() { events.push('connections'); if (throwConnections) throw Error('sensitive connection detail'); },
  };
  const app = { all() {}, use() {}, get() {}, listen(_port,_host,cb) {startup=cb;return server;} };
  const express = Object.assign(() => app, { json: () => () => {} });
  const logger = {
    info(...args) { events.push('info'); if (throwInfo && !starting) throw Error('sensitive info detail'); },
    error(...args) { events.push(['error', ...args]); if (throwError) throw Error('sensitive error detail'); },
  };
  const dependencies = {
    express: { default: express }, './config/env.js': { env: {} }, './utils/logger.js': { logger },
    './upstream/oauth.js': { stopOAuth() { events.push('oauth'); if (throwOAuth) throw Error('sensitive oauth detail'); if (rejectOAuth) return Promise.reject(Error('sensitive oauth detail')); return done; } },
    './upstream/siwc-login.js': { stopSiwc() { events.push('siwc'); return done; }, noStoreSiwc() {} },
    './upstream/tokens.js': { drainTokenRefreshes() { events.push('refresh'); return done; } },
    './request-work.js': { requestWork:{stopAndDrain:()=>done}, trackedErrorHandler: handler => handler },
    './db/client.js': { initDatabase() {initCalls++;}, requireInitializedDatabase() {}, closeDatabase() { events.push('database'); if (throwDatabase) throw Error('sensitive database detail'); } },
    './db/async-writer.js': { retryQuarantinedWriters() { events.push('writers'); } },
    './db/account-429-v2-store.js': {assert429V2Schema(){}},
    './db/account-429-v2-expiry.js': {Account429V2Expiry:class {start(){expiryStarts++;} stopAndDrain(){expiryStops++;return done;}}},
    './routes/v1.js': { default: {} }, './routes/admin.js': { default: {} },
  };
  const proc = { on(name, handler) { signals[name] = handler; }, exit(code) { events.push(['exit', code]); } };
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(`(function(exports,require,process,setTimeout,clearTimeout){${compiled}\n})`)({}, name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, proc, (callback, delay) => { events.push('timer'); const timer = { callback, delay, cleared: false, unreferenced:false,unref(){this.unreferenced=true;events.push('unref');} }; timers.push(timer); return timer; }, timer => { timer.cleared = true; events.push('clear'); });
  assert.equal(typeof startup,'function'); startup(); starting=false;
  assert.equal(initCalls,1); assert.equal(expiryStarts,1); assert.equal(proc.exitCode,undefined);
  assert.deepEqual(events,['info','info']); events.length=0;
  let elapsed = 0;
  function advance(ms) {
    elapsed += ms;
    for (const timer of timers) {
      if (!timer.cleared && !timer.fired && elapsed >= timer.delay) {
        timer.fired = true;
        timer.callback();
      }
    }
  }
  return { events, signals, timers, proc, advance, get expiryStops(){return expiryStops;} };
}

test('info failure cannot prevent installing or firing the one hard deadline', () => {
  const f = fixture({ throwInfo: true });
  assert.doesNotThrow(() => f.signals.SIGTERM());
  assert.equal(f.expiryStops,1);
  f.signals.SIGINT();
  assert.equal(f.timers.length, 1);
  assert.equal(f.events[0], 'timer');
  assert.equal(f.timers[0].delay, 5000);
  f.advance(4999);
  assert.ok(!f.events.some(event => Array.isArray(event) && event[0] === 'exit'));
  f.advance(1);
  assert.ok(f.events.some(event => Array.isArray(event) && event[0] === 'exit' && event[1] === 1));
  assert.ok(!f.events.includes('database'));
});

for (const [label, options] of [
  ['logger.error', { throwError: true }],
  ['closeAllConnections', { throwConnections: true }],
]) {
  test(`deadline exits even when ${label} throws`, () => {
    const f = fixture(options);
    f.signals.SIGTERM();
    assert.equal(f.timers[0].delay, 5000);
    assert.doesNotThrow(() => f.advance(5000));
    assert.ok(f.events.includes('connections'));
    assert.ok(f.events.some(event => Array.isArray(event) && event[0] === 'exit' && event[1] === 1));
    assert.ok(!f.events.includes('database'));
    assert.equal(JSON.stringify(f.events).includes('sensitive'), false);
  });
}

test('synchronous OAuth failure still starts remaining shutdown and retains deadline', async () => {
  const f = fixture({ throwOAuth: true, pending: false });
  assert.doesNotThrow(() => f.signals.SIGTERM());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events.filter(e => typeof e === 'string' && ['oauth', 'siwc', 'refresh', 'close'].includes(e)), ['refresh', 'oauth', 'siwc', 'close', 'oauth']);
  assert.equal(f.proc.exitCode, 1);
  assert.equal(f.timers[0].cleared, false);
  assert.ok(!f.events.includes('database'));
  assert.equal(JSON.stringify(f.events).includes('sensitive'), false);
  f.advance(5000);
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'exit' && e[1] === 1));
});

test('completed registered drains retain database and unref the armed deadline', async () => {
  const f = fixture({ pending: false });
  f.signals.SIGTERM();
  assert.equal(f.expiryStops,1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.events.includes('writers'));
  assert.ok(!f.events.includes('database'));
  assert.equal(f.timers[0].cleared, false);
  assert.equal(f.timers[0].unreferenced, true);
  assert.equal(f.proc.exitCode, undefined);
  f.advance(5000);
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'exit' && e[1] === 1));
});

test('HTTP close failure retains deadline and logs no raw error', async () => {
  const f = fixture({ pending: false, closeError: Error('sensitive close detail') });
  f.signals.SIGTERM();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.proc.exitCode, 1);
  assert.equal(f.timers[0].cleared, false);
  assert.ok(!f.events.includes('database'));
  assert.equal(JSON.stringify(f.events).includes('sensitive'), false);
  f.advance(5000);
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'exit' && e[1] === 1));
});

test('rejected OAuth drain is handled and keeps the deadline', async () => {
  const f = fixture({ rejectOAuth: true, pending: false, throwError: true });
  f.signals.SIGTERM();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.proc.exitCode, 1);
  assert.equal(f.timers[0].cleared, false);
  assert.ok(!f.events.includes('database'));
  f.advance(5000);
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'exit' && e[1] === 1));
});

test('completed drains do not call an unsafe database close', async () => {
  const f = fixture({ pending: false, throwDatabase: true, throwError: true });
  f.signals.SIGTERM();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.proc.exitCode, undefined);
  assert.equal(f.timers[0].cleared, false);
  assert.ok(!f.events.includes('database'));
  assert.equal(JSON.stringify(f.events).includes('sensitive'), false);
  f.advance(5000);
  assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'exit' && e[1] === 1));
});

test('hard shutdown deadline exits nonzero without closing an active database', () => {
  let deadline, signal, closeDatabaseCalls = 0, exitCode, startup, initCalls=0, expiryStarts=0, expiryStops=0;
  const app = { all() {}, use() {}, get() {}, listen(_port,_host,cb) {startup=cb;return { on() {}, close() {}, closeAllConnections() {} }; } };
  const express = Object.assign(() => app, { json: () => () => {} });
  const logger = { info() {}, error() {} };
  const never = new Promise(() => {});
  const dependencies = {
    express: { default: express }, './config/env.js': { env: {} }, './utils/logger.js': { logger },
    './upstream/oauth.js': { stopOAuth: () => never },
    './upstream/siwc-login.js': { stopSiwc: () => never, noStoreSiwc() {} },
    './upstream/tokens.js': { drainTokenRefreshes: () => never },
    './request-work.js': { requestWork:{stopAndDrain:()=>never}, trackedErrorHandler: handler => handler },
    './db/client.js': { initDatabase() {initCalls++;}, requireInitializedDatabase() {}, closeDatabase() { closeDatabaseCalls++; } },
    './db/async-writer.js': { retryQuarantinedWriters() {} },
    './db/account-429-v2-store.js': {assert429V2Schema(){}},
    './db/account-429-v2-expiry.js': {Account429V2Expiry:class {start(){expiryStarts++;} stopAndDrain(){expiryStops++;return never;}}},
    './routes/v1.js': { default: {} }, './routes/admin.js': { default: {} },
  };
  const fakeProcess = { on(name, handler) { if (name === 'SIGTERM') signal = handler; }, exit(code) { exitCode = code; } };
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function(exports,require,process,setTimeout,clearTimeout){${compiled}\n})`)({}, name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, fakeProcess, callback => { deadline = callback; return 1; }, () => {});
  assert.equal(typeof startup,'function'); startup();
  assert.equal(initCalls,1); assert.equal(expiryStarts,1); assert.equal(fakeProcess.exitCode,undefined);
  signal();
  assert.equal(expiryStops,1);
  deadline();
  assert.equal(exitCode, 1);
  assert.equal(closeDatabaseCalls, 0, 'database must remain open while work may still use it');
});
