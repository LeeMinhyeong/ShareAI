import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
function load(file, deps, extras = {}) {
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Promise, ...extras })((name) => {
    if (!Object.hasOwn(deps, name)) throw new Error('Unexpected dependency: ' + name);
    return deps[name];
  }, mod, mod.exports);
  return mod.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

// All dependencies, listener, timers, DB and process are synthetic. No socket,
// database, configuration, or provider is opened by this fixture.
function fixture(options = {}) {
  const work = load('src/request-work.ts', { 'node:async_hooks': require('node:async_hooks') });
  const signals = new Map(), events = [], gates = { oauth: deferred(), siwc: deferred(), tokens: deferred() };
  let closeCallback, listenCallback, errorHandler, shutdownTimer, cleared = false, exits = 0, oauthCalls = 0, now = 0;
  let startup = true, startupError, startupThrew = false, initCalls = 0;
  const logs = [], timers = new Set();
  const setTimer = (fn, ms) => { const timer = { fn, at: now + ms, unref() {} }; timers.add(timer); return timer; };
  const clearTimer = timer => { if (timer === shutdownTimer) cleared = true; timers.delete(timer); };
  const advance = ms => { now += ms; for (const timer of [...timers]) if (timer.at <= now && timers.delete(timer)) timer.fn(); };
  const process = { exitCode: 0, on(name, callback) { signals.set(name, callback); }, exit(code) { assert.equal(code, 1); exits++; } };
  const logger = { info(...args) {
    logs.push(['info', ...args]);
    if (startup) { if (options.throwStartupLogger) throw options.throwStartupLogger; return; }
    if (options.reenter) signals.get('SIGINT')();
    if (options.onLog) options.onLog(work);
    if (options.throwLogger) throw false;
  }, error(...args) { logs.push(['error', ...args]); if (options.throwLogger) throw false; } };
  const express = Object.assign(() => ({ all() {}, use(...args) {
    if (typeof args[0] === 'function' && args[0].length === 4) errorHandler = args[0];
  }, get() {}, listen(_port, _host, callback) { listenCallback = callback; return {
    on() {},
    close(callback) { events.push('listener'); closeCallback = callback; },
    closeAllConnections() { events.push('force'); },
  }; } }), { json: () => () => {} });
  const stop = name => {
    events.push(name);
    assert.equal(work.requestWork.isAccepting(), false, 'stop hook saw open root admission');
    if (name === 'oauth') oauthCalls++;
    if (name === options.throwStop && (name !== 'oauth' || oauthCalls === 1)) throw options.thrown;
    if (name === options.reject && (name !== 'oauth' || oauthCalls === 1)) return Promise.reject(undefined);
    return gates[name].promise;
  };
  load('src/server.ts', {
    express, './config/env.js': { env: {} }, './utils/logger.js': { logger },
    './upstream/oauth.js': { stopOAuth: () => stop('oauth') },
    './upstream/siwc-login.js': { stopSiwc: () => stop('siwc'), noStoreSiwc() {} },
    './upstream/tokens.js': { drainTokenRefreshes: () => stop('tokens') }, './request-work.js': work,
    './db/client.js': { initDatabase() { initCalls++; }, requireInitializedDatabase(){}, closeDatabase() { events.push('db'); } },
    './db/async-writer.js': { retryQuarantinedWriters() { events.push('writers'); } },
    './db/account-429-v2-store.js': { assert429V2Schema() {} },
    './db/account-429-v2-expiry.js': { Account429V2Expiry: class { start() {} stopAndDrain() { return Promise.resolve(); } } },
    './routes/v1.js': { default() {}, __esModule: true }, './routes/admin.js': { default() {}, __esModule: true },
  }, { process, setTimeout(fn, ms) { assert.equal(ms, 5000); const timer=setTimer(fn, ms); shutdownTimer=timer; timer.unref=()=>events.push('unref'); return timer; }, clearTimeout: clearTimer });
  // Deliver the synthetic listen event only after app.listen has returned and
  // server.ts has installed its signal handlers, as an asynchronous event would.
  try { listenCallback(); } catch (error) { startupThrew = true; startupError = error; }
  startup = false;
  if (!options.throwStartupLogger && startupThrew) throw startupError;
  return { work, signals, events, gates, process, advance, setTimer, clearTimer, logs, errorHandler,
    startupThrew, startupError, initCalls, close: err => closeCallback(err),
    fireDeadline: () => advance(5000), get cleared() { return cleared; }, get exits() { return exits; } };
}
function resolveDrains(f) { for (const gate of Object.values(f.gates)) gate.resolve(); }

for (const thrown of [false, null, undefined, 0]) {
  for (const hook of ['oauth', 'siwc', 'tokens']) {
    test(`synchronous ${String(thrown)} from ${hook} retains failure and deadline`, async () => {
      const f = fixture({ throwStop: hook, thrown, throwLogger: true });
      f.signals.get('SIGTERM')(); f.close(); resolveDrains(f);
      await flush(); await flush();
      if (hook === 'oauth') assert.equal(f.events.filter(x => x === 'oauth').length, 2);
      assert.equal(f.process.exitCode, 1);
      assert.equal(f.events.includes('db'), false);
      assert.equal(f.cleared, false);
      f.advance(4999); assert.equal(f.exits, 0);
      f.advance(1); assert.equal(f.exits, 1);
      assert.equal(f.events.includes('force'), true);
    });
  }
}

test('listen event initializes database and emits both startup messages', () => {
  const f = fixture();
  assert.equal(f.startupThrew, false);
  assert.equal(f.initCalls, 1);
  assert.equal(f.logs.filter(([level]) => level === 'info').length, 2);
  assert.equal(f.logs[0][2], '🚀 Multi-Account Router started');
  assert.match(f.logs[1][1], /architecture and implementation guide/);
});

test('synchronous startup logger throw fails startup and retains deadline', () => {
  const fault = new Error('synthetic startup logger fault');
  const f = fixture({ throwStartupLogger: fault });
  assert.equal(f.startupThrew, false);
  assert.equal(f.initCalls, 1);
  assert.equal(f.logs.length, 2);
  assert.equal(f.logs[1][0], 'error');
  assert.equal(f.logs[1][1], 'Server startup failed');
  assert.equal(JSON.stringify(f.logs).includes(fault.message), false);
  assert.equal(f.events.includes('listener'), true);
  assert.equal(f.events.includes('db'), false);
  assert.equal(f.process.exitCode, 1);
  f.fireDeadline();
  assert.equal(f.exits, 1);
});

for (const listenerBeforeDeadline of [false, true]) {
  test(`owned rejection after deadline with listener ${listenerBeforeDeadline ? 'already closed' : 'still pending'}`, { timeout: 3000 }, async () => {
    const f = fixture();
    const held = deferred();
    const secret = 'synthetic-late-rejection-secret';
    const rejection = listenerBeforeDeadline ? false : new Error(secret);
    let started = false, settled = false;
    const task = f.work.requestWork.run(() => { started = true; return held.promise; });
    assert.equal(started, true);
    assert.ok(task);
    const observed = task.then(
      () => { settled = true; return { fulfilled: true }; },
      error => { settled = true; return { fulfilled: false, error }; },
    );
    f.signals.get('SIGTERM')();
    if (listenerBeforeDeadline) f.close();
    await flush();
    assert.equal(settled, false);
    assert.equal(f.events.includes('db'), false);
    f.advance(4999);
    assert.equal(f.exits, 0);
    f.advance(1);
    assert.equal(f.exits, 1);
    assert.equal(f.process.exitCode, 1);
    assert.equal(f.events.filter(x => x === 'force').length, 1);
    assert.equal(f.logs.filter(([level, message]) => level === 'error' && message === 'Shutdown deadline exceeded; terminating remaining work').length, 1);
    assert.equal(JSON.stringify(f.logs).includes(secret), false);
    assert.equal(f.events.includes('db'), false);
    assert.equal(f.cleared, false);

    held.reject(rejection);
    const outcome = await observed;
    assert.equal(settled, true);
    assert.equal(outcome.fulfilled, false);
    assert.equal(outcome.error, rejection);
    if (!listenerBeforeDeadline) f.close();
    resolveDrains(f);
    await flush(); await flush();
    assert.equal(f.events.includes('db'), false);
    assert.equal(f.events.includes('writers'), false);
    assert.equal(f.cleared, false);
    assert.equal(f.exits, 1);
    f.advance(5000);
    assert.equal(f.exits, 1);
    assert.deepEqual(f.logs.filter(([level]) => level === 'error'), [
      ['error', 'Shutdown deadline exceeded; terminating remaining work'],
    ]);

    // Separately exercise the installed error middleware's post-stop response;
    // this is not a claim that the rejected task dispatched that middleware.
    let status, body;
    const res = { headersSent: false, status(code) { status = code; return this; }, json(value) { body = value; return this; } };
    f.errorHandler(new Error(secret), { path: '/synthetic', method: 'GET' }, res, () => assert.fail('unexpected next'));
    assert.equal(status, 503);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });
}

test('owned work completed before deadline allows unref without closing database', { timeout: 3000 }, async () => {
  const f = fixture(); const held = deferred();
  let started = false;
  const task = f.work.requestWork.run(() => { started = true; return held.promise; });
  assert.equal(started, true);
  f.signals.get('SIGTERM')(); f.close(); resolveDrains(f);
  await flush();
  assert.equal(f.events.includes('db'), false);
  f.advance(4999); assert.equal(f.exits, 0);
  held.resolve('finished');
  assert.equal(await task, 'finished');
  await flush(); await flush();
  assert.equal(f.events.filter(x => x === 'db').length, 0);
  assert.equal(f.events.filter(x => x === 'writers').length, 0);
  assert.equal(f.events.filter(x => x === 'unref').length, 1);
  assert.equal(f.cleared, false);
  f.advance(1); assert.equal(f.exits, 1);
});

test('idle shutdown retains database and unrefs deadline after all drains', async () => {
  const f = fixture();
  f.signals.get('SIGTERM')(); f.close(); resolveDrains(f);
  await flush();
  assert.equal(f.events.includes('writers'), false);
  assert.equal(f.events.includes('db'), false);
  assert.equal(f.events.filter(x => x === 'unref').length, 1);
  assert.equal(f.cleared, false);
  assert.equal(f.process.exitCode, 0);
});

for (const force of [false, true]) {
  test(`server shutdown owns SIWC post-claim flight${force ? ' through deadline' : ' until finish'}`, { timeout: 3000 }, async () => {
    let rootResult = 'not attempted', rootRan = false;
    const f = fixture({ onLog(work) { rootResult = work.requestWork.run(() => { rootRan = true; }); } });
    const claim = deferred(), finish = deferred();
    const old = { revision: 'old', credential: { clientId: 'synthetic-client', refreshToken: 'synthetic-old', savedAt: new Date().toISOString(), expiresIn: 3600 } };
    let current = old, claims = 0, providers = 0, finishes = 0;
    const store = { db: {}, refreshConnection() { return { store, close() {} }; },
      claimRefresh() { claims++; return claim.promise; },
      finishRefresh(_id, _intent, credential) { finishes++; return finish.promise.then(() => (current = { revision: 'new', credential })); },
      readSnapshot() { return current; },
    };
    const refresh = load('src/upstream/siwc-refresh.ts', {
      jose: {}, './siwc-store.js': {}, '../request-work.js': f.work,
    }, { AbortController, AbortSignal, URLSearchParams, setTimeout: f.setTimer, clearTimeout: f.clearTimer });
    const task = refresh.refreshSiwcSnapshot(store, 'synthetic-id', old, async () => {
      providers++;
      return { status: 200, async json() { return { access_token: 'synthetic-access', refresh_token: 'synthetic-new', token_type: 'Bearer', expires_in: 3600 }; } };
    });
    await flush();
    assert.equal(claims, 1); assert.equal(providers, 0);
    f.signals.get('SIGTERM')();
    assert.equal(rootResult, undefined); assert.equal(rootRan, false);
    f.close(); resolveDrains(f); await flush();
    assert.equal(f.events.includes('db'), false);
    claim.resolve({ credential: old.credential });
    await flush();
    assert.equal(providers, 1); assert.equal(finishes, 1);
    assert.equal(f.events.includes('db'), false);
    if (force) {
      f.advance(4999); assert.equal(f.exits, 0);
      f.advance(1); assert.equal(f.exits, 1);
      assert.equal(f.events.includes('db'), false);
    }
    finish.resolve();
    await task; await flush();
    assert.equal(providers, 1); assert.equal(finishes, 1);
    assert.equal(f.events.includes('db'), false);
    assert.equal(f.events.includes('writers'), false);
    assert.equal(f.events.filter(x => x === 'unref').length, force ? 0 : 1);
    assert.equal(f.cleared, false);
    assert.equal(f.process.exitCode, force ? 1 : 0);
  });
}

test('shutdown closes admission before hooks and waits for owned work and all other drains', async () => {
  const f = fixture({ reenter: true });
  const held = deferred();
  const task = f.work.requestWork.run(() => held.promise);
  f.signals.get('SIGTERM')();
  assert.equal(f.work.requestWork.run(() => assert.fail('late root ran')), undefined);
  assert.deepEqual(f.events, ['tokens', 'oauth', 'siwc', 'listener']);
  f.close(); f.gates.oauth.resolve(); f.gates.siwc.resolve();
  await flush(); assert.equal(f.events.includes('db'), false);
  held.resolve(); await task; await flush(); assert.equal(f.events.includes('db'), false);
  f.gates.tokens.resolve(); await flush();
  assert.equal(f.events.includes('writers'), false);
  assert.equal(f.events.includes('db'), false);
  assert.equal(f.events.filter(x => x === 'unref').length, 1);
  assert.equal(f.cleared, false);
});

test('falsey drain rejection and throwing logger retain the deadline after retry', async () => {
  const f = fixture({ reject: 'oauth', throwLogger: true });
  f.signals.get('SIGTERM')(); f.close(); resolveDrains(f);
  await flush(); await flush();
  assert.equal(f.events.filter(x => x === 'oauth').length, 2);
  assert.equal(f.events.includes('db'), false);
  assert.equal(f.cleared, false);
  assert.equal(f.process.exitCode, 1);
  f.fireDeadline(); assert.equal(f.exits, 1);
});

test('deadline prevents late database close after a held task finishes', async () => {
  const f = fixture(); const held = deferred();
  const task = f.work.requestWork.run(() => held.promise);
  f.signals.get('SIGTERM')(); f.close(); resolveDrains(f);
  f.fireDeadline(); assert.equal(f.exits, 1);
  held.resolve(); await task; await flush();
  assert.equal(f.events.includes('db'), false);
  assert.equal(f.cleared, false);
});

test('rejected tracked handler releases its ownership before deadline unref', async () => {
  const f = fixture(); const held = deferred();
  const task = f.work.requestWork.run(() => held.promise);
  const observed = task.catch(() => {});
  f.signals.get('SIGINT')(); f.close(); resolveDrains(f);
  await flush(); assert.equal(f.events.includes('db'), false);
  held.reject(false); await observed; await flush();
  assert.equal(f.events.includes('db'), false);
  assert.equal(f.events.filter(x => x === 'unref').length, 1);
  assert.equal(f.cleared, false);
});
