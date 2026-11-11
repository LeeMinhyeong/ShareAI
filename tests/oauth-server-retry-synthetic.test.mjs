// Production OAuth and server shutdown with synthetic listeners; no sockets or DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function syntheticEnv(values = {}, reads = []) {
  const env = Object.freeze(Object.assign(Object.create(null), {
    CLAUDE_OAUTH_CLIENT_ID: values.CLAUDE_OAUTH_CLIENT_ID,
    CODEX_OAUTH_CLIENT_ID: values.CODEX_OAUTH_CLIENT_ID,
  }));
  return new Proxy(env, { get(target, key) {
    if (!Object.hasOwn(target, key)) throw Error('unexpected synthetic env access');
    reads.push(key); return target[key];
  } });
}
function fakeConsole(calls = []) {
  const output = {}; let fail = false, failure;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'assert']) {
    output[method] = (...args) => { calls.push([method, args]); if (fail) throw failure; };
  }
  return { output: Object.freeze(output), calls, failWith(value) { fail = true; failure = value; } };
}
function load(file, deps, globals = {}, env = syntheticEnv(), inspect = () => {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const fakeProcess = globals.process || {};
  Object.defineProperty(fakeProcess, 'env', { value: env, writable: false, configurable: false });
  const context = { Buffer, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, ...globals, module, exports: module.exports, process: fakeProcess, console: globals.console || fakeConsole().output,
    require: id => { if (!Object.hasOwn(deps, id)) throw Error('unexpected import ' + id); return id === 'process' || id === 'node:process' ? fakeProcess : deps[id]; } };
  inspect(context);
  vm.runInNewContext(code, context);
  return module.exports;
}
function fixture({ throwLogger = false, fetch = () => { throw Error('unexpected fetch'); }, stopOAuth, stopSiwc, drainRefresh, env = {}, inspect = () => {} } = {}) {
  const reads = [], isolatedEnv = syntheticEnv(env, reads);
  const callbacks = [], signals = {}, deadlines = [], state = { db: 0, exit: 0, code: 0, cleared: 0, unref: 0, siwc: 0, refresh: 0, closeAll: 0, stops: 0 };
  const errors = []; errors.info = []; errors.warn = []; const capturedConsole = fakeConsole(); errors.console = capturedConsole.calls;
  let shuttingDown = false;
  const logger = { info(...args) { errors.info.push(args); if (throwLogger && shuttingDown) throw Error('logger'); }, warn(...args) { errors.warn.push(args); }, error(...args) { errors.push(args); if (throwLogger && shuttingDown) throw Error('logger'); } };
  const callbackServer = { once() {}, listen(_port, _host, cb) { this.ready = cb; }, close(cb) { callbacks.push(cb); }, closeAllConnections() { state.closeAll++; } };
  const oauth = load('../src/upstream/oauth.ts', { crypto: require('node:crypto'), http: { createServer: () => callbackServer }, '../utils/logger.js': { logger } }, { fetch, console: capturedConsole.output, setTimeout: () => ({ unref() {} }) }, isolatedEnv, inspect);
  let httpClose, startup, initCalls=0, expiryStarts=0, expiryStops=0, starting=true;
  const startupInfo=[];
  const serverLogger={...logger,info(...args){if(starting)startupInfo.push(args);else logger.info(...args);}};
  const server = { on() {}, close(cb) { httpClose = cb; }, closeAllConnections() {} };
  const app = { all() {}, use() {}, get() {}, listen(_port,_host,cb) { startup=cb; return server; } };
  const express = Object.assign(() => app, { json: () => () => {} });
  const fakeProcess = { on(name, cb) { signals[name] = cb; }, exit(code) { state.exit = code; }, get exitCode() { return state.code; }, set exitCode(v) { state.code = v; } };
  load('../src/server.ts', { express, './http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js': { env: {} }, './utils/logger.js': { logger:serverLogger }, './upstream/oauth.js': { ...oauth, stopOAuth() { state.stops++; return stopOAuth ? stopOAuth(state.stops, oauth) : oauth.stopOAuth(); } }, './upstream/siwc-login.js': { stopSiwc() { state.siwc++; return stopSiwc ? stopSiwc() : Promise.resolve(); }, noStoreSiwc() {} }, './upstream/tokens.js': { drainTokenRefreshes() { state.refresh++; return drainRefresh ? drainRefresh() : Promise.resolve(); } }, './request-work.js': { trackedErrorHandler: x => x, requestWork: { stopAndDrain: async () => {} } }, './db/client.js': { initDatabase() {initCalls++;}, requireInitializedDatabase() {}, closeDatabase() { state.db++; } }, './db/async-writer.js': { retryQuarantinedWriters() {} }, './db/account-429-v2-store.js': { assert429V2Schema() {} }, './db/account-429-v2-expiry.js': { Account429V2Expiry: class { start() {expiryStarts++;} stopAndDrain() {expiryStops++;return Promise.resolve();} } }, './routes/v1.js': {}, './routes/admin.js': {} }, { process: fakeProcess, console: capturedConsole.output, setTimeout(fn, ms) { assert.equal(ms, 5000); deadlines.push(fn); return { unref() { state.unref++; } }; }, clearTimeout() { state.cleared++; } });
  assert.equal(typeof startup,'function'); startup(); starting=false;
  assert.equal(initCalls,1); assert.equal(expiryStarts,1); assert.equal(state.code,0);
  assert.equal(startupInfo.length,2); assert.equal(startupInfo[0][1],'🚀 Multi-Account Router started');
  assert.match(startupInfo[1][0],/architecture and implementation guide/);
  return { oauth, callbackServer, callbacks, state, errors, reads, isolatedEnv, logger, fakeConsole: capturedConsole.output, failConsole: capturedConsole.failWith, start: () => { shuttingDown = true; signals.SIGTERM(); assert.equal(expiryStops,1); }, closeHttp: error => httpClose(error), fireDeadline: () => deadlines[0](), deadlines };
}
async function sentinelCheck(probe = async () => {}) {
 try {
  const sentinel = 'synthetic-token-like-client-id';
  let context;
  const f = fixture({ env: { CODEX_OAUTH_CLIENT_ID: sentinel }, inspect: value => { context = value; } });
  assert.notEqual(context.process, process);
  assert.equal(vm.runInNewContext('globalThis.process === process', context), true);
  assert.throws(() => context.require('process'), /unexpected import/);
  assert.throws(() => context.require('node:process'), /unexpected import/);
  assert.throws(() => context.require('toString'), /unexpected import/);
  assert.deepEqual(f.reads, ['CLAUDE_OAUTH_CLIENT_ID', 'CODEX_OAUTH_CLIENT_ID']);
  assert.throws(() => f.isolatedEnv.UNKNOWN, /unexpected synthetic env access/);
  assert.equal(Object.isFrozen(f.isolatedEnv), true);
  assert.equal(Reflect.set(f.isolatedEnv, 'CODEX_OAUTH_CLIENT_ID', 'other'), false);
  const flow = await start(f);
  assert.equal(new URL(flow.authUrl).searchParams.get('client_id') === sentinel, true, 'synthetic client ID not used');
  await probe(f, sentinel);
  const visible = JSON.stringify([f.errors, f.errors.info, f.errors.warn, f.errors.console]);
  assert.equal(f.errors.length === 0 && f.errors.warn.length === 0 && f.errors.console.length === 0 &&
    f.errors.info.length === 1 && f.errors.info[0].length === 1 && f.errors.info[0][0] === 'Codex OAuth callback listening on :1455' &&
    !visible.includes(sentinel), true, 'unexpected synthetic output');
 } catch { throw Error('synthetic environment check failed'); }
}
test('OAuth VM uses only explicitly configured synthetic environment', { timeout: 2000 }, () => sentinelCheck());
test('sentinel diagnostics suppress fake output and thrown or rejected values', { timeout: 2000 }, async () => {
  for (const probe of [
    (f, secret) => f.fakeConsole.error({ secret }),
    (f, secret) => f.logger.warn({ secret }),
    (f, secret) => { f.failConsole(Error(secret)); f.fakeConsole.log(secret); },
    (f, secret) => { f.logger.error(secret); return Promise.reject(Error(secret)); },
  ]) {
    let safe = false;
    try { await sentinelCheck(probe); } catch (error) { safe = String(error) === 'Error: synthetic environment check failed' && !String(error.stack).includes('synthetic-token-like-client-id'); }
    assert.equal(safe, true, 'unsafe synthetic diagnostic');
  }
});
const deadlineLog = 'Shutdown deadline exceeded; terminating remaining work';
function checkLogs(f, expected, listenerStarted = true) {
  assert.equal(f.errors.console.length === 0, true, 'unexpected console output');
  assert.equal(f.errors.length === expected.length && f.errors.every((args, i) =>
    args.length === 1 && typeof args[0] === 'string' && args[0] === expected[i] &&
    !args[0].includes('fixture-secret') && !args[0].includes('synthetic')), true, 'unexpected failure log');
  const info = f.errors.info, offset = listenerStarted ? 1 : 0;
  assert.equal(f.errors.warn.length === 0 && info.length === offset + 1 &&
    (!listenerStarted || (info[0].length === 1 && info[0][0] === 'Codex OAuth callback listening on :1455')) &&
    info[offset].length === 2 && info[offset][1] === 'Shutting down gracefully' && info[offset][0] !== null &&
    typeof info[offset][0] === 'object' && Object.keys(info[offset][0]).length === 1 && info[offset][0].signal === 'SIGTERM',
  true, 'unexpected non-error log');
}
async function start(f) { const p = f.oauth.startLogin('openai', { name: 'fixture' }); f.callbackServer.ready(); return await p; }
test('production shutdown retries a transient callback close once and waits for retry', { timeout: 2000 }, async () => {
  const f = fixture(); await start(f); f.start(); assert.equal(f.deadlines.length, 1); f.closeHttp();
  await tick(); assert.equal(f.callbacks.length, 1); f.callbacks[0](Error('close failure sentinel'));
  await tick(); assert.equal(f.callbacks.length, 2, 'shutdown must retry the retained listener');
  assert.equal(f.state.db, 0); f.callbacks[1](); await tick();
  assert.equal(f.state.db, 0); assert.equal(f.state.code, 1); assert.equal(f.state.cleared, 0); assert.equal(f.state.unref, 0);
  assert.equal(f.state.siwc, 1); assert.equal(f.state.refresh, 1); assert.equal(f.state.closeAll, 2);
  checkLogs(f, ['Failed to stop OAuth']);
});
test('synthetic callback errors are redacted from shutdown logs and observable errors', { timeout: 2000 }, async () => {
  try {
    const markers = ['fixture-secret-token', 'synthetic-error-body'];
    const f = fixture(); await start(f); f.start(); f.closeHttp(); await tick();
    f.callbacks[0](Error(markers.join(' '))); await tick();
    assert.equal(f.callbacks.length, 2); f.callbacks[1](); await tick();
    checkLogs(f, ['Failed to stop OAuth']);
    assert.equal(f.state.code, 1); assert.equal(f.state.db, 0);
    const direct = fixture(); await start(direct);
    const stop = direct.oauth.stopOAuth().then(() => ({ rejected: false }), error => ({ rejected: true, message: String(error?.message), stack: String(error?.stack), text: String(error), properties: JSON.stringify(error, Object.getOwnPropertyNames(error)) }));
    await tick(); direct.callbacks[0](Error(markers.join(' ')));
    const observed = await stop;
    assert.equal(observed.rejected, true);
    const retry = direct.oauth.stopOAuth(); await tick();
    assert.equal(direct.callbacks.length, 2); direct.callbacks[1](); await retry;
    assert.equal(direct.errors.length === 0 && direct.errors.warn.length === 0 && direct.errors.info.length === 1 && direct.errors.info[0].length === 1 && direct.errors.info[0][0] === 'Codex OAuth callback listening on :1455', true, 'unexpected direct OAuth logs');
    const visible = JSON.stringify([f.errors, f.errors.info, f.errors.warn, f.errors.console, direct.errors, direct.errors.info, direct.errors.warn, direct.errors.console, observed]);
    assert.equal(direct.errors.console.length === 0, true, 'unexpected console output');
    assert.equal(markers.some(marker => visible.includes(marker)), false, 'synthetic redaction failed');
  } catch {
    throw Error('synthetic redaction check failed');
  }
});
test('persistent close failure is bounded even when logging throws', { timeout: 2000 }, async () => {
  const f = fixture({ throwLogger: true }); await start(f); f.start(); f.start(); f.closeHttp();
  await tick(); f.callbacks[0](Error('first')); await tick();
  assert.equal(f.callbacks.length, 2); f.callbacks[1](Error('second')); await tick();
  assert.equal(f.callbacks.length, 2); assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0);
  assert.equal(f.state.siwc, 1); assert.equal(f.state.refresh, 1);
  f.fireDeadline(); assert.equal(f.state.exit, 1); assert.equal(f.state.db, 0);
  checkLogs(f, ['Failed to log shutdown', 'Failed to stop OAuth', 'Failed to retry stopping OAuth', deadlineLog]);
});
test('deadline prevents late failed stop from launching retry', { timeout: 2000 }, async () => {
  const f = fixture(); await start(f); f.start(); f.closeHttp(); await tick();
  f.fireDeadline(); f.callbacks[0](Error('late')); await tick();
  assert.equal(f.callbacks.length, 1); assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0); assert.equal(f.state.exit, 1);
  checkLogs(f, [deadlineLog, 'Failed to stop OAuth']);
});
test('late successful retry cannot close DB after deadline', { timeout: 2000 }, async () => {
  const f = fixture(); await start(f); f.start(); f.closeHttp(); await tick();
  f.callbacks[0](Error('first')); await tick(); assert.equal(f.callbacks.length, 2);
  f.fireDeadline(); f.callbacks[1](); await tick();
  assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0); assert.equal(f.state.exit, 1);
  checkLogs(f, ['Failed to stop OAuth', deadlineLog]);
});
test('successful first close is not retried', { timeout: 2000 }, async () => {
  const f = fixture(); await start(f); f.start(); f.closeHttp(); await tick();
  assert.equal(f.state.unref, 0);
  f.callbacks[0](); await tick(); assert.equal(f.callbacks.length, 1); assert.equal(f.state.db, 0); assert.equal(f.state.unref, 1); assert.equal(f.state.cleared, 0); assert.equal(f.state.code, 0);
  checkLogs(f, []);
});
test('in-flight exchange is not replayed and must settle before any retry or DB close', { timeout: 2000 }, async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ fetch: () => { calls++; return gate; } });
  const flow = await start(f), state = new URL(flow.authUrl).searchParams.get('state');
  const operation = f.oauth.finishLogin(flow.flowId, `code#${state}`).then(() => false, error => error?.message === '로그인을 완료하지 못했습니다. 다시 시도해주세요.');
  assert.equal(calls, 1); f.start(); f.closeHttp(); await tick(); f.callbacks[0](Error('first'));
  await tick(); assert.equal(f.callbacks.length, 1); assert.equal(f.state.db, 0);
  release({ ok: false, status: 400, text: async () => 'synthetic-error-body fixture-secret-token' }); assert.equal(await operation, true, 'unexpected exchange outcome'); await tick();
  assert.equal(f.callbacks.length, 2); assert.equal(calls, 1); assert.equal(f.state.db, 0);
  f.callbacks[1](); await tick(); assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0); assert.equal(calls, 1);
  checkLogs(f, ['Failed to stop OAuth']);
});

for (const [name, value] of [['undefined', undefined], ['null', null], ['false', false], ['zero', 0], ['empty string', '']]) {
  test(`falsey OAuth rejection ${name} remains a failure after one retry`, { timeout: 2000 }, async () => {
    const f = fixture({ stopOAuth: () => Promise.reject(value) });
    f.start(); assert.equal(f.deadlines.length, 1); f.closeHttp(); await tick();
    assert.equal(f.state.stops, 2); assert.equal(f.state.code, 1);
    assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0);
    assert.equal(f.state.siwc, 1); assert.equal(f.state.refresh, 1);
    f.fireDeadline(); assert.equal(f.state.exit, 1); assert.equal(f.state.db, 0);
    checkLogs(f, ['Failed to stop OAuth', 'Failed to retry stopping OAuth', deadlineLog], false);
  });
}

test('falsey first rejection retries successfully without losing failure status', { timeout: 2000 }, async () => {
  const f = fixture({ stopOAuth: count => count === 1 ? Promise.reject(undefined) : Promise.resolve() });
  f.start(); assert.equal(f.deadlines.length, 1); f.closeHttp(); await tick();
  assert.equal(f.state.stops, 2); assert.equal(f.state.code, 1);
  assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0);
  checkLogs(f, ['Failed to stop OAuth'], false);
});

test('synchronous OAuth stop throws twice and leaves the deadline armed', { timeout: 2000 }, async () => {
  const f = fixture({ stopOAuth: () => { throw undefined; } });
  f.start(); assert.equal(f.deadlines.length, 1); f.closeHttp(); await tick();
  assert.equal(f.state.stops, 2); assert.equal(f.state.code, 1);
  assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0);
  f.fireDeadline(); assert.equal(f.state.exit, 1); assert.equal(f.state.db, 0);
  checkLogs(f, ['Failed to stop OAuth', 'Failed to retry stopping OAuth', deadlineLog], false);
});

test('HTTP close failure prevents DB close after successful OAuth retry', { timeout: 2000 }, async () => {
  const f = fixture(); await start(f); f.start(); assert.equal(f.deadlines.length, 1);
  f.closeHttp(Error('synthetic HTTP close')); await tick();
  f.callbacks[0](Error('synthetic OAuth close')); await tick();
  assert.equal(f.callbacks.length, 2); f.callbacks[1](); await tick();
  assert.equal(f.state.stops, 2); assert.equal(f.state.code, 1);
  assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0);
  f.fireDeadline(); assert.equal(f.state.exit, 1); assert.equal(f.state.db, 0);
  checkLogs(f, ['Failed to close HTTP server', 'Failed to stop OAuth', deadlineLog]);
});

for (const drain of ['stopSiwc', 'drainRefresh']) {
  for (const mode of ['reject', 'throw']) {
    test(`${drain} ${mode} prevents DB close after OAuth retry`, { timeout: 2000 }, async () => {
      const failure = () => { if (mode === 'throw') throw null; return Promise.reject(false); };
      const f = fixture({ [drain]: failure }); await start(f);
      f.start(); assert.equal(f.deadlines.length, 1); f.closeHttp(); await tick();
      f.callbacks[0](Error('synthetic OAuth close')); await tick();
      assert.equal(f.callbacks.length, 2); f.callbacks[1](); await tick();
      assert.equal(f.state.stops, 2); assert.equal(f.state.code, 1);
      assert.equal(f.state.siwc, 1); assert.equal(f.state.refresh, 1);
      assert.equal(f.state.db, 0); assert.equal(f.state.cleared, 0);
      f.fireDeadline(); assert.equal(f.state.exit, 1); assert.equal(f.state.db, 0);
      checkLogs(f, [drain === 'stopSiwc' ? 'Failed to stop SIWC' : 'Failed to drain token refreshes', 'Failed to stop OAuth', deadlineLog]);
    });
  }
}
