const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.join(__dirname, '..');
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
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'assert']) output[method] = (...args) => { calls.push([method, args]); if (fail) throw failure; };
  return { output: Object.freeze(output), calls, failWith(value) { fail = true; failure = value; } };
}
function load(file, deps, globals = {}, env = syntheticEnv(), inspect = () => {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const text = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const fakeProcess = globals.process || {};
  Object.defineProperty(fakeProcess, 'env', { value: env, writable: false, configurable: false });
  const context = { Buffer, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, ...globals, module, exports: module.exports, process: fakeProcess, console: globals.console || fakeConsole().output,
    require: id => { if (!Object.hasOwn(deps, id)) throw Error('unexpected import ' + id); return id === 'process' || id === 'node:process' ? fakeProcess : deps[id]; } };
  inspect(context);
  vm.runInNewContext(text, context, { filename: file });
  return module.exports;
}
function oauthFixture(values = {}, inspect = () => {}) {
  const reads = [], env = syntheticEnv(values, reads);
  const servers = [];
  const http = { createServer() { const callbacks = []; let notify; const server = { listen(_port, _host, cb) { this.listening = cb; }, once() {}, close(cb) { if (this.closeMode === 'throw') throw Error('synthetic close'); this.closed = cb; callbacks.push(cb); if (notify) { notify(); notify = null; } }, async waitForClose(count) { while (callbacks.length < count) await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('close registration timed out')), 2000); notify = () => { clearTimeout(timer); resolve(); }; }); return callbacks[count - 1]; }, closeAllConnections() {} }; servers.push(server); return server; } };
  const errors = []; errors.info = []; errors.warn = []; const capturedConsole = fakeConsole(); errors.console = capturedConsole.calls;
  const logger = { info(...args) { errors.info.push(args); }, warn(...args) { errors.warn.push(args); }, error(...args) { errors.push(args); } };
  let now = 0;
  class FakeDate extends Date { static now() { return now; } }
  const oauth = load('src/upstream/oauth.ts', { crypto, http, '../utils/logger.js': { logger } }, { Date: FakeDate, console: capturedConsole.output, setTimeout: () => ({ unref() {} }) }, env, inspect);
  return { oauth, servers, errors, env, reads, logger, fakeConsole: capturedConsole.output, failConsole: capturedConsole.failWith, advance: ms => { now += ms; } };
}
async function environmentCheck(probe = async () => {}) {
 try {
  const sentinel = 'synthetic-token-like-client-id'; let context;
  const f = oauthFixture({ CODEX_OAUTH_CLIENT_ID: sentinel }, value => { context = value; });
  assert.notEqual(context.process, process);
  assert.equal(vm.runInNewContext('globalThis.process === process', context), true);
  assert.throws(() => context.require('process'), /unexpected import/);
  assert.throws(() => context.require('node:process'), /unexpected import/);
  assert.throws(() => context.require('toString'), /unexpected import/);
  assert.deepEqual(f.reads, ['CLAUDE_OAUTH_CLIENT_ID', 'CODEX_OAUTH_CLIENT_ID']);
  assert.throws(() => f.env.UNKNOWN, /unexpected synthetic env access/);
  assert.equal(Object.isFrozen(f.env), true);
  assert.equal(Reflect.set(f.env, 'CODEX_OAUTH_CLIENT_ID', 'other'), false);
  const starting = f.oauth.startLogin('openai', { name: 'fixture' });
  f.servers[0].listening(); const flow = await starting;
  assert.equal(new URL(flow.authUrl).searchParams.get('client_id') === sentinel, true, 'synthetic client ID not used');
  const stop = f.oauth.stopOAuth(); (await f.servers[0].waitForClose(1))(); await stop;
  await probe(f, sentinel);
  checkLogs(f.errors, []);
  const visible = JSON.stringify([f.errors, f.errors.info, f.errors.warn, f.errors.console]);
  assert.equal(!visible.includes(sentinel), true, 'unexpected synthetic output');
 } catch { throw Error('synthetic environment check failed'); }
}
async function environmentIsolation() {
  await environmentCheck();
  for (const probe of [
    (f, secret) => f.fakeConsole.error({ secret }),
    (f, secret) => f.logger.warn({ secret }),
    (f, secret) => { f.failConsole(Error(secret)); f.fakeConsole.log(secret); },
    (f, secret) => { f.logger.error(secret); return Promise.reject(Error(secret)); },
  ]) {
    let safe = false;
    try { await environmentCheck(probe); } catch (error) { safe = String(error) === 'Error: synthetic environment check failed' && !String(error.stack).includes('synthetic-token-like-client-id'); }
    assert.equal(safe, true, 'unsafe synthetic diagnostic');
  }
}
async function syncClose() {
  const { oauth, servers, errors } = oauthFixture();
  const starting = oauth.startLogin('openai', { name: 'fixture' });
  servers[0].listening(); await starting;
  servers[0].closeMode = 'throw';
  const stop = oauth.stopOAuth();
  await assert.rejects(stop, /close/i, 'shutdown must report synchronous listener close failure');
  checkLogs(errors, []);
}
async function listenerLifecycle() {
  const { oauth, servers, advance, errors } = oauthFixture();
  const first = oauth.startLogin('openai', { name: 'fixture' });
  servers[0].listening(); const flow = await first;
  assert.equal(flow.callbackListening, true);
  advance(600001); assert.equal(oauth.getFlow(flow.flowId), null);
  const second = oauth.startLogin('openai', { name: 'fixture' });
  await tick(); assert.equal(servers.length, 1, 'relisten must await close');
  servers[0].closed(); await tick(); assert.equal(servers.length, 2);
  servers[1].listening(); assert.equal((await second).callbackListening, true);
  const stop = oauth.stopOAuth(); assert.equal(stop, oauth.stopOAuth());
  let done = false; void stop.then(() => { done = true; });
  await tick(); assert.equal(done, false, 'stop must await listener close');
  servers[1].closed(); await stop; assert.equal(done, true);
  await assert.rejects(oauth.startLogin('openai', { name: 'fixture' }), /shutting down/);
  checkLogs(errors, [], 'listener', 2);
}
async function stopDuringRelisten() {
  const { oauth, servers, advance, errors } = oauthFixture();
  const first = oauth.startLogin('openai', { name: 'fixture' });
  servers[0].listening(); const flow = await first;
  advance(600001); oauth.getFlow(flow.flowId);
  const second = oauth.startLogin('openai', { name: 'fixture' });
  const stop = oauth.stopOAuth(); assert.equal(stop, oauth.stopOAuth());
  let settled = false; void stop.then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(servers.length, 1);
  servers[0].closed(); await stop;
  assert.equal((await second).callbackListening, false); assert.equal(servers.length, 1);
  checkLogs(errors, []);
}
async function pendingStartup() {
  const { oauth, servers, errors } = oauthFixture();
  const start = oauth.startLogin('openai', { name: 'fixture' });
  const stop = oauth.stopOAuth(); let done = false;
  void stop.then(() => { done = true; });
  await tick(); assert.equal(done, false);
  servers[0].listening(); assert.equal((await start).callbackListening, false);
  await tick(); assert.equal(done, false);
  servers[0].closed(); await stop; assert.equal(done, true);
  checkLogs(errors, [], 'listener', 0);
}
async function asyncCloseError() {
  const { oauth, servers, errors } = oauthFixture();
  const start = oauth.startLogin('openai', { name: 'fixture' });
  servers[0].listening(); await start;
  const stop = oauth.stopOAuth();
  (await servers[0].waitForClose(1))(Error('fixture-secret-must-not-escape'));
  await assert.rejects(stop, e => /close failed/.test(e.message) && !e.message.includes('fixture-secret'));
  const retry = oauth.stopOAuth();
  (await servers[0].waitForClose(2))();
  await retry;
  checkLogs(errors, []);
}
async function ignoredCloseError() {
  const { oauth, servers, advance, errors } = oauthFixture();
  const start = oauth.startLogin('openai', { name: 'fixture' });
  servers[0].listening(); const flow = await start;
  advance(600001); oauth.getFlow(flow.flowId);
  (await servers[0].waitForClose(1))(Error('fixture-secret-must-not-escape'));
  await tick();
  const stop = oauth.stopOAuth(); // Intentionally not observed until the next turn.
  await tick();
  (await servers[0].waitForClose(2))(Error('synthetic retry close'));
  await assert.rejects(stop, /close failed/);
  checkLogs(errors, []);
}
function serverFixture(stopOAuth = () => Promise.resolve()) {
  const events = {}; let closeCb, deadlineCb, closedDb = 0, exited = 0, cleared = 0;
  const server = { close(cb) { closeCb = cb; }, closeAllConnections() {} };
  const app = { all() {}, use() {}, get() {}, listen() { return server; } };
  const express = Object.assign(() => app, { json: () => () => {} });
  const errors = []; errors.info = []; errors.warn = []; const capturedConsole = fakeConsole(); errors.console = capturedConsole.calls;
  const logger = { info(...args) { errors.info.push(args); }, warn(...args) { errors.warn.push(args); }, error(...args) { errors.push(args); } };
  const fakeProcess = { on(name, fn) { events[name] = fn; }, exit(code) { exited = code; }, exitCode: 0 };
  load('src/server.ts', { express, './config/env.js': { env: {} }, './utils/logger.js': { logger }, './upstream/oauth.js': { stopOAuth }, './upstream/siwc-login.js': { stopSiwc: () => Promise.resolve(), noStoreSiwc() {} }, './upstream/tokens.js': { drainTokenRefreshes: () => Promise.resolve() }, './request-work.js': { trackedErrorHandler: x => x, requestWork: { stopAndDrain: async () => {} } }, './db/client.js': { initDatabase() {}, closeDatabase() { closedDb++; } }, './db/async-writer.js': { retryQuarantinedWriters() {} }, './routes/v1.js': {}, './routes/admin.js': {} }, { process: fakeProcess, console: capturedConsole.output, setTimeout: (fn, ms) => { assert.equal(ms, 5000); deadlineCb = fn; return 1; }, clearTimeout: () => { cleared++; } });
  return { errors, shutdown: () => events.SIGTERM(), fire: () => deadlineCb(), close: () => closeCb(), state: () => ({ closedDb, exited, cleared, exitCode: fakeProcess.exitCode }) };
}
function checkLogs(logs, expected, kind = 'listener', count = 1) {
  assert.equal(logs.console.length === 0, true, 'unexpected console output');
  assert.equal(logs.length === expected.length && logs.every((args, i) =>
    args.length === 1 && typeof args[0] === 'string' && args[0] === expected[i] &&
    !args[0].includes('fixture-secret') && !args[0].includes('synthetic')), true, 'unexpected failure log');
  assert.equal(logs.warn.length === 0 && logs.info.length === count && logs.info.every(args =>
    kind === 'listener' ? (args.length === 1 && args[0] === 'Codex OAuth callback listening on :1455') :
    (args.length === 2 && args[1] === 'Shutting down gracefully' && args[0] !== null &&
      typeof args[0] === 'object' && Object.keys(args[0]).length === 1 && args[0].signal === 'SIGTERM')),
  true, 'unexpected non-error log');
}
async function deadline() {
  const f = serverFixture(); f.shutdown(); f.fire(); f.close(); await tick();
  assert.deepEqual(f.state(), { closedDb: 0, exited: 1, cleared: 0, exitCode: 1 });
  checkLogs(f.errors, ['Shutdown deadline exceeded; terminating remaining work'], 'shutdown');
}
async function serverDrain() {
  const f = serverFixture(); f.shutdown(); f.close(); await tick();
  assert.deepEqual(f.state(), { closedDb: 1, exited: 0, cleared: 1, exitCode: 0 });
  checkLogs(f.errors, [], 'shutdown');
}
async function serverCloseFailure() {
  const { oauth, servers, errors } = oauthFixture();
  const start = oauth.startLogin('openai', { name: 'fixture' });
  servers[0].listening(); await start;
  const f = serverFixture(oauth.stopOAuth); f.shutdown(); f.close();
  (await servers[0].waitForClose(1))(Error('synthetic close'));
  (await servers[0].waitForClose(2))(Error('synthetic retry close')); await tick();
  assert.deepEqual(f.state(), { closedDb: 0, exited: 0, cleared: 0, exitCode: 1 });
  f.fire(); await tick();
  assert.deepEqual(f.state(), { closedDb: 0, exited: 1, cleared: 0, exitCode: 1 });
  checkLogs(f.errors, ['Failed to stop OAuth', 'Failed to retry stopping OAuth', 'Shutdown deadline exceeded; terminating remaining work'], 'shutdown');
  checkLogs(errors, []);
}
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(e));
(async () => {
  let failed = false;
  for (const [name, fn] of [['environment isolation', environmentIsolation], ['sync close', syncClose], ['listener lifecycle and relisten', listenerLifecycle], ['stop during relisten', stopDuringRelisten], ['pending startup', pendingStartup], ['async close error', asyncCloseError], ['ignored close error', ignoredCloseError], ['irreversible deadline', deadline], ['normal server drain', serverDrain], ['server OAuth failure', serverCloseFailure]]) {
    let timer, timedOut = false;
    try {
      // These fixtures inject only fake I/O; a race alone cannot reap real handles.
      await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(); }, 2500); })]);
      console.log('PASS', name);
    } catch {
      failed = true;
      console.log('FAIL', name, timedOut ? 'case deadline' : 'case assertion or unexpected error');
    } finally { clearTimeout(timer); }
    if (timedOut) break;
  }
  await tick();
  if (unhandled.length) { failed = true; console.log('FAIL unhandled rejections'); }
  process.exitCode = failed ? 1 : 0;
})();
