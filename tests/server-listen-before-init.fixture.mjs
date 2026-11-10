// Production server entrypoint with synthetic dependencies and no sockets/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const code = ts.transpileModule(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ init = () => {}, schema = () => {}, start = () => {} } = {}) {
  const events = [];
  const signals = {};
  let startup, listenerError, closed, gate, gateBeforeRoute = false, sawRoute = false, exits = 0;
  const server = {
    on(name, cb) { if (name === 'error') listenerError = cb; return this; },
    close(cb) { events.push('listener-close'); if (cb) closed = cb; },
    closeAllConnections() {},
  };
  const app = {
    all() {}, get() { sawRoute = true; },
    use(...args) { if (!gate && args.length === 1 && typeof args[0] === 'function') { gate = args[0]; gateBeforeRoute = !sawRoute; } },
    listen(_port, _host, cb) { events.push('listen'); startup = cb; return server; },
  };
  const express = Object.assign(() => app, {json: () => function parser() {}});
  const processFake = { exitCode: 0, on(name, cb) { signals[name] = cb; }, exit() {exits++;}, hrtime: {bigint: () => 1n} };
  const deps = {
    express: {default: express}, './config/env.js': {env: {PORT: 12345, HOST: '127.0.0.1'}},
    './utils/logger.js': {logger: {info() {}, error() {}}},
    './upstream/oauth.js': {stopOAuth: async () => {}}, './upstream/siwc-login.js': {stopSiwc: async () => {}, noStoreSiwc() {}},
    './upstream/tokens.js': {drainTokenRefreshes: async () => { events.push('tokens-stop'); }},
    './request-work.js': {trackedErrorHandler: fn => fn, requestWork: {stopAndDrain: async () => { events.push('requests-stop'); }}},
    './db/client.js': {initDatabase() { events.push('init'); init(signals); }, requireInitializedDatabase() { return {}; }},
    './db/account-429-v2-store.js': {assert429V2Schema() { events.push('schema'); schema(signals); }},
    './db/account-429-v2-expiry.js': {Account429V2Expiry: class {start() { events.push('expiry-start'); start(signals); } stopAndDrain() { events.push('expiry-stop'); return Promise.resolve(); }}},
    './routes/v1.js': {default: {}}, './routes/admin.js': {default: {}},
  };
  const timeout = () => ({unref() {}});
  vm.runInThisContext(`(function(exports,require,process,setTimeout,clearTimeout){${code}\n})`)({}, name => {
    if (!Object.hasOwn(deps, name)) throw Error('unexpected dependency');
    return deps[name];
  }, processFake, timeout, () => {});
  const admission = () => {
    let status = null, next = false;
    const res = {status(code) {status = code; return this;}, end() {return this;}, json() {return this;}};
    gate({}, res, () => {next = true;});
    return {status, next};
  };
  return {events, signals, processFake, gateBeforeRoute, exits: () => exits, startup: () => startup(), error: () => listenerError(Error('synthetic bind')), admission, close: () => closed?.()};
}

test('startup waits for bind and gates requests until initialization', () => {
  const h = harness();
  assert.deepEqual(h.events, ['listen']);
  assert.equal(h.gateBeforeRoute, true);
  assert.deepEqual(h.admission(), {status: 503, next: false});
  h.startup();
  assert.deepEqual(h.events, ['listen', 'init', 'schema', 'expiry-start']);
  assert.deepEqual(h.admission(), {status: null, next: true});
});

test('bind error does not initialize DB and keeps admission closed', () => {
  const h = harness();
  h.error();
  assert.equal(h.events.includes('init'), false);
  assert.equal(h.processFake.exitCode, 1);
  h.startup();
  assert.equal(h.events.includes('init'), false);
  assert.deepEqual(h.admission(), {status: 503, next: false});
});

test('initialization error closes listener and keeps admission closed', () => {
  const h = harness({init() {throw Error('synthetic initialization failure');}});
  assert.doesNotThrow(() => h.startup());
  assert.equal(h.processFake.exitCode, 1);
  assert.equal(h.events.includes('listener-close'), true);
  assert.equal(h.events.includes('expiry-start'), false);
  h.startup();
  assert.equal(h.events.filter(event => event === 'init').length, 1);
  assert.deepEqual(h.admission(), {status: 503, next: false});
});

test('shutdown before listening callback prevents later initialization', async () => {
  const h = harness();
  h.signals.SIGTERM();
  h.startup();
  assert.equal(h.events.includes('init'), false);
  assert.deepEqual(h.admission(), {status: 503, next: false});
  h.close();
  await new Promise(resolve => setImmediate(resolve));
  h.startup();
  assert.equal(h.events.includes('init'), false);
  assert.equal(h.exits(), 0);
  assert.deepEqual(h.admission(), {status: 503, next: false});
});

test('reentrant shutdown during init prevents expiry and admission', () => {
  const h = harness({init(signals) {signals.SIGTERM();}});
  h.startup();
  assert.equal(h.events.includes('schema'), false);
  assert.equal(h.events.includes('expiry-start'), false);
  assert.deepEqual(h.admission(), {status: 503, next: false});
  h.close();
});

test('shutdown after successful initialization closes admission immediately and permanently', async () => {
  const h = harness(); h.startup();
  assert.deepEqual(h.admission(), {status: null, next: true});
  h.signals.SIGTERM();
  assert.deepEqual(h.admission(), {status: 503, next: false});
  h.close();
  await new Promise(resolve => setImmediate(resolve));
  h.startup();
  assert.equal(h.events.filter(event => event === 'init').length, 1);
  assert.equal(h.exits(), 0);
  assert.deepEqual(h.admission(), {status: 503, next: false});
});

test('reentrant shutdown during schema validation prevents expiry and admission', () => {
  const h = harness({schema(signals) {signals.SIGTERM();}});
  h.startup();
  assert.equal(h.events.includes('expiry-start'), false);
  assert.deepEqual(h.admission(), {status: 503, next: false});
  h.close();
});

test('reentrant shutdown during scheduler start stops it and keeps admission closed', () => {
  const h = harness({start(signals) {signals.SIGTERM();}});
  h.startup();
  assert.equal(h.events.includes('expiry-stop'), true);
  assert.deepEqual(h.admission(), {status: 503, next: false});
  h.close();
});
