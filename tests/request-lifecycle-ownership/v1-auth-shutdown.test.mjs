import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Duplex, Readable } from 'node:stream';
import { ServerResponse } from 'node:http';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const express = require('express');

function load(relative, dependencies, extras = {}) {
  const source = readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const localRequire = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error('Unexpected fixture dependency');
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Promise, AbortController, setTimeout, clearTimeout, ...extras })(localRequire, module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

// The owned in-memory stream is not a native socket; no real configuration,
// SQLite connection, or provider module is opened or exercised.
function fixture(gated) {
  const entered = deferred(), release = deferred(), settled = deferred(), deadlineUnref = deferred(), forwarded = deferred();
  const drainPromises = {};
  const stop = name => {
    const promise = Promise.resolve().then(() => { events.push(name); });
    drainPromises[name] = promise;
    return promise;
  };
  const signals = new Map();
  const events = [];
  const syntheticDb = {};
  let forwardCalls = 0, quotaCalls = 0, signal;
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const work = load('src/request-work.ts', { 'node:async_hooks': require('node:async_hooks') });
  const auth = load('src/auth/user-auth.ts', {
    '../db/repositories/users.js': { UserRepository: class { reserveDailyQuota(hash, date, db) {
      if (hash !== 'synthetic-hash' || date !== undefined || db !== syntheticDb) throw new Error('Unexpected quota arguments');
      quotaCalls++;
      return { allowed: true, used: 1, user: { id: 'user', name: 'Synthetic', email: 'synthetic@example.invalid', tier: 'free', dailyLimit: 10 } };
    } } },
    '../utils/encryption.js': { hashApiKey: () => 'synthetic-hash' },
    '../utils/logger.js': { logger }, '../config/env.js': { env: {} },
    '../db/async-writer.js': { withAsyncWriter: (callback, options) => {
      signal = options.signal;
      entered.resolve();
      return (gated ? release.promise : Promise.resolve()).then(() => {
        try { return callback(syntheticDb); }
        finally { events.push('writer-settled'); settled.resolve(); }
      });
    } },
    '../request-work.js': work,
  });
  const v1 = load('src/routes/v1.ts', { express, '../config/env.js': { env: { NODE_ENV: 'test' } }, '../auth/user-auth.js': auth,
    '../upstream/forward-chat.js': { forwardChat(req, res) {
      forwardCalls++;
      res.status(200).json({ ok: true, source: 'synthetic-forward' });
      forwarded.resolve(req.user);
    } },
    '../request-work.js': work, '../utils/logger.js': { logger } });
  let app, listenerClose, listenerStarted;
  const fakeExpress = Object.assign(() => {
    app = express();
    app.listen = (_port, _host, callback) => { listenerStarted = callback; return { on() {}, close(callback) { listenerClose = callback; }, closeAllConnections() {} }; };
    return app;
  }, express);
  const fakeProcess = { exitCode: 0, on(name, fn) { signals.set(name, fn); }, exit() { throw new Error('Unexpected deadline'); } };
  load('src/server.ts', {
    express: fakeExpress, './config/env.js': { env: { PORT: 0, HOST: 'synthetic', NODE_ENV: 'test' } },
    './utils/logger.js': { logger }, './upstream/oauth.js': { stopOAuth: () => stop('oauth') },
    './upstream/siwc-login.js': { stopSiwc: () => stop('siwc'), noStoreSiwc: (_req, _res, next) => next() },
    './upstream/tokens.js': { drainTokenRefreshes: () => stop('tokens') },
    './request-work.js': work, './db/client.js': { initDatabase() {}, requireInitializedDatabase() {}, closeDatabase() { events.push('db-close'); } },
    './db/async-writer.js': { retryQuarantinedWriters() { events.push('retry'); } },
    './db/account-429-v2-store.js': { assert429V2Schema() {} },
    './db/account-429-v2-expiry.js': { Account429V2Expiry: class { start() {} stopAndDrain() { return Promise.resolve(); } } },
    './routes/v1.js': v1, './routes/admin.js': { default: express.Router(), __esModule: true },
  }, { process: fakeProcess, setTimeout: (_fn, delay) => { assert.equal(delay, 5000); return { unref() { events.push('deadline-unref'); deadlineUnref.resolve(); } }; }, clearTimeout: () => { events.push('deadline-cleared'); } });
  assert.equal(typeof listenerStarted, 'function');
  listenerStarted();
  const req = new Readable({ read() {} });
  req.method = 'POST'; req.url = '/v1/chat/completions'; req.headers = { authorization: 'Bearer synthetic' };
  const res = new ServerResponse(req);
  const chunks = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  res.assignSocket(socket);
  const responseFinished = deferred(), responseClosed = deferred();
  let closeEvents = 0, finishEvents = 0;
  res.on('close', () => { closeEvents++; responseClosed.resolve(); });
  res.on('finish', () => { finishEvents++; responseFinished.resolve(); });
  return { app, req, res, socket, chunks, responseFinished, responseClosed, work, signals, events, entered, release, settled, deadlineUnref, forwarded, drainPromises,
    get listenerClose() { return listenerClose; }, get signal() { return signal; },
    get quotaCalls() { return quotaCalls; }, get forwardCalls() { return forwardCalls; },
    get closeEvents() { return closeEvents; }, get finishEvents() { return finishEvents; } };
}

async function runFixture(gated, exercise) {
  const f = fixture(gated);
  let failed = false, primary;
  try {
    f.app.handle(f.req, f.res);
    await exercise(f);
  } catch (error) { failed = true; primary = error; }
  finally {
    f.release.resolve();
    try { await bounded(f.work.requestWork.stopAndDrain(), 'owned request drain in cleanup'); }
    catch (error) {
      if (failed) throw new AggregateError([primary, error], 'test and cleanup both failed');
      throw error;
    }
    finally { f.socket.destroy(); }
  }
  if (failed) throw primary;
}

test('valid v1 authentication reaches the forwarding handler once', async () => {
  await runFixture(false, async f => {
    await bounded(f.entered.promise, 'quota writer entered');
    const user = await bounded(f.forwarded.promise, 'forward handler entered');
    await bounded(f.settled.promise, 'quota writer settled');
    await bounded(f.responseFinished.promise, 'synthetic response finish');
    assert.equal(user.id, 'user');
    assert.equal(f.quotaCalls, 1);
    assert.equal(f.forwardCalls, 1);
    assert.equal(f.res.statusCode, 200);
    assert.equal(f.res.writableEnded, true);
    assert.equal(f.res.writableFinished, true);
    assert.equal(f.finishEvents, 1);
    const response = Buffer.concat(f.chunks).toString('utf8');
    assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
    assert.deepEqual(JSON.parse(response.split('\r\n\r\n')[1]), { ok: true, source: 'synthetic-forward' });
  });
});

test('shutdown must wait for disconnected v1 authentication quota work', async () => {
  await runFixture(true, async f => {
    await bounded(f.entered.promise, 'quota writer entered');
    // Destroy the response and owned stream; Node emits the response close once.
    assert.equal(f.res.destroyed, false);
    assert.equal(f.closeEvents, 0);
    f.res.destroy();
    assert.equal(f.res.destroyed, true, 'route must observe a destroyed response');
    await bounded(f.responseClosed.promise, 'synthetic response close');
    assert.equal(f.closeEvents, 1, 'synthetic response closes exactly once');
    assert.equal(f.signal.aborted, true, 'disconnect must abort the real authentication signal');
    f.signals.get('SIGTERM')();
    assert.equal(typeof f.listenerClose, 'function', 'production shutdown must close listener');
    for (const name of ['oauth', 'siwc', 'tokens']) {
      assert.ok(f.drainPromises[name] instanceof Promise, `${name} drain must start`);
      await bounded(f.drainPromises[name], `${name} drain settlement`);
    }
    const drain = f.work.requestWork.stopAndDrain();
    let drained = false;
    void drain.then(() => { drained = true; });
    await bounded(new Promise(resolve => setImmediate(resolve)), 'request drain observation');
    assert.equal(drained, false, 'request ownership must remain active while writer is held');
    assert.equal(f.events.includes('writer-settled'), false, 'writer gate must still be held');
    f.listenerClose();
    await bounded(new Promise(resolve => setImmediate(resolve)), 'shutdown continuation');
    assert.equal(f.events.includes('db-close'), false, 'database closed before authentication writer settled');
    assert.equal(f.events.includes('deadline-unref'), false, 'shutdown completed before authentication writer settled');
    f.release.resolve();
    await bounded(f.settled.promise, 'quota writer terminal');
    await bounded(drain, 'request drain');
    await bounded(f.deadlineUnref.promise, 'deadline unref observed');
    // The production listener callback returns void. Let its Promise.all
    // continuation finish before inspecting the retained handles.
    await bounded(new Promise(resolve => setImmediate(resolve)), 'shutdown continuation after unref');
    assert.equal(f.quotaCalls, 1, 'released writer must execute the real authentication quota callback');
    assert.equal(f.forwardCalls, 0, 'disconnected request must not forward');
    assert.equal(f.res.destroyed, true);
    assert.equal(f.closeEvents, 1, 'response must not receive a second close');
    assert.equal(f.finishEvents, 0, 'disconnected response must not finish');
    assert.deepEqual(f.events.filter(x => ['oauth', 'siwc', 'tokens'].includes(x)).sort(), ['oauth', 'siwc', 'tokens']);
    assert.equal(f.events.includes('db-close'), false);
    assert.equal(f.events.includes('retry'), false);
    assert.equal(f.events.includes('deadline-cleared'), false);
    assert.ok(f.events.indexOf('writer-settled') < f.events.indexOf('deadline-unref'));
  });
});
