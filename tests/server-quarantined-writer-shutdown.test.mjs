import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function harness({ retry = () => {}, loggerThrows = false, tokenDrain = () => Promise.resolve() } = {}) {
  const events = [];
  const handlers = new Map();
  let timer;
  let httpClose, startup, initCalls=0, expiryStarts=0, expiryStops=0, starting=true;
  const process = {
    exitCode: undefined,
    on(signal, handler) { handlers.set(signal, handler); },
    exit(code) { events.push(`exit:${code}`); },
  };
  const server = {
    on() {},
    close(callback) { events.push('http-close'); httpClose = callback; },
    closeAllConnections() { events.push('close-connections'); },
  };
  const app = { all() {}, use() {}, get() {}, listen(_port,_host,cb) { startup=cb; return server; } };
  const express = () => app;
  express.json = () => () => {};
  const logger = {
    info() { if (loggerThrows && !starting) throw new Error('logger'); },
    error() { events.push('log-error'); if (loggerThrows) throw new Error('logger'); },
  };
  const modules = {
    express,
    './config/env.js': { env: {} },
    './utils/logger.js': { logger },
    './upstream/oauth.js': { stopOAuth() { events.push('oauth'); return Promise.resolve(); } },
    './upstream/siwc-login.js': { stopSiwc() { events.push('siwc'); return Promise.resolve(); }, noStoreSiwc() {} },
    './upstream/tokens.js': { drainTokenRefreshes() { events.push('tokens'); return tokenDrain(); } },
    './request-work.js': { requestWork:{stopAndDrain:()=>Promise.resolve()}, trackedErrorHandler: fn => fn },
    './db/client.js': { initDatabase() {initCalls++;}, requireInitializedDatabase() {}, closeDatabase() { events.push('db-close'); } },
    './db/async-writer.js': { retryQuarantinedWriters() { events.push('retry'); return retry(); } },
    './db/account-429-v2-store.js': {assert429V2Schema(){}},
    './db/account-429-v2-expiry.js': {Account429V2Expiry:class {start(){expiryStarts++;} stopAndDrain(){expiryStops++;return Promise.resolve();}}},
    './routes/v1.js': {},
    './routes/admin.js': {},
  };
  const context = {
    exports: {}, process,
    require(name) {
      if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency: ${name}`);
      return modules[name];
    },
    setTimeout(callback, delay) { assert.equal(delay, 5000); events.push('arm'); timer = {callback,unref(){events.push('unref');}}; return timer; },
    clearTimeout(id) { assert.equal(id, timer); events.push('clear'); },
  };
  runInNewContext(compiled, context, { filename: 'server.js' });
  assert.equal(typeof startup,'function'); startup(); starting=false;
  assert.equal(initCalls,1); assert.equal(expiryStarts,1); assert.equal(process.exitCode,undefined);
  return {
    events, process, get expiryStops(){return expiryStops;},
    shutdown() { handlers.get('SIGTERM')(); },
    closeHttp(error) { assert.ok(httpClose); httpClose(error); },
    deadline() { assert.ok(timer); timer.callback(); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('shutdown never calls quarantined-writer retry or closes the shared database', async () => {
  const h = harness({ retry() { throw new Error('unconfirmed writer'); } });
  h.shutdown();
  assert.equal(h.expiryStops,1);
  h.closeHttp();
  await settle();
  assert.deepEqual(h.events, ['arm', 'tokens', 'oauth', 'siwc', 'http-close', 'unref']);
  assert.equal(h.process.exitCode, undefined);
  h.deadline();
  assert.ok(h.events.includes('exit:1'));
});

// Ported from the former -extra.tmp cases to the current ADR 0009 contract:
// shutdown never retries quarantined writers or closes the shared database,
// and only a fully successful drain unrefs the deadline.
const count = (h, name) => h.events.filter(event => event === name).length;
const assertDbRetained = h => {
  assert.equal(count(h, 'retry'), 0);
  assert.equal(count(h, 'db-close'), 0);
  assert.equal(count(h, 'clear'), 0);
};

for (const value of [undefined, null, false, 0, '']) {
  test(`falsey synchronous drain throw ${JSON.stringify(value) ?? 'undefined'} fails shutdown and keeps deadline referenced`, async () => {
    const h = harness({ tokenDrain() { throw value; } });
    h.shutdown();
    h.closeHttp();
    await settle();
    assert.equal(h.process.exitCode, 1);
    assert.equal(count(h, 'unref'), 0);
    // A synchronous throw must not stop the remaining drains or HTTP close.
    for (const name of ['oauth', 'siwc', 'http-close']) assert.equal(count(h, name), 1, name);
    assertDbRetained(h);
    h.deadline();
    assert.deepEqual(h.events.slice(-3), ['log-error', 'close-connections', 'exit:1']);
  });

  test(`falsey drain rejection ${JSON.stringify(value) ?? 'undefined'} fails shutdown and keeps deadline referenced`, async () => {
    const h = harness({ tokenDrain() { return Promise.reject(value); } });
    h.shutdown();
    h.closeHttp();
    await settle();
    assert.equal(h.process.exitCode, 1);
    assert.equal(count(h, 'unref'), 0);
    assertDbRetained(h);
    h.deadline();
    assert.deepEqual(h.events.slice(-3), ['log-error', 'close-connections', 'exit:1']);
  });
}

test('throwing logger does not stop drains and still reports failure', async () => {
  const h = harness({ loggerThrows: true });
  h.shutdown();
  h.closeHttp();
  await settle();
  assert.equal(h.process.exitCode, 1);
  assert.equal(count(h, 'tokens'), 1);
  assert.equal(count(h, 'oauth'), 1);
  assert.equal(count(h, 'siwc'), 1);
  assert.equal(count(h, 'unref'), 1);
  assertDbRetained(h);
  h.deadline();
  assert.deepEqual(h.events.slice(-3), ['log-error', 'close-connections', 'exit:1']);
});

test('successful repeated shutdown drains once, unrefs, and retains the database', async () => {
  const h = harness();
  h.shutdown();
  h.shutdown();
  h.closeHttp();
  await settle();
  assert.deepEqual(h.events, ['arm', 'tokens', 'oauth', 'siwc', 'http-close', 'unref']);
  assert.equal(h.process.exitCode, undefined);
});

test('HTTP close error fails shutdown and keeps deadline referenced', async () => {
  const h = harness();
  h.shutdown();
  h.closeHttp(new Error('synthetic close failure'));
  await settle();
  assert.equal(h.process.exitCode, 1);
  assert.equal(count(h, 'unref'), 0);
  assertDbRetained(h);
  h.deadline();
  assert.deepEqual(h.events.slice(-3), ['log-error', 'close-connections', 'exit:1']);
});

test('late drain settlement after deadline cannot unref or exit twice', async () => {
  let resolveDrain;
  const h = harness({ tokenDrain() { return new Promise(resolve => { resolveDrain = resolve; }); } });
  h.shutdown();
  h.closeHttp();
  await settle();
  h.deadline();
  h.deadline();
  resolveDrain();
  await settle();
  assert.equal(h.process.exitCode, 1);
  assert.equal(count(h, 'unref'), 0);
  assert.equal(count(h, 'exit:1'), 1);
  assertDbRetained(h);
});
