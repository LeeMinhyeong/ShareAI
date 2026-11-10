import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/upstream/siwc-login.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(options = {}) {
  const routes = new Map(); let server; let claims = 0; let exchanges = 0; const timers = []; let now = 0;
  const db = { prepare: () => ({ get: () => ({}) }), transaction: fn => ({ immediate: fn }), exec() {} };
  class Server {
    handlers = {}; errors = new Set(); closeCallbacks = []; listening = true;
    once(name, cb) { if (name === 'error') this.errors.add(cb); else this.handlers[name] = cb; return this; }
    removeListener(name, cb) { if (name === 'error') this.errors.delete(cb); return this; }
    listen(_port, _host, cb) { if (options.listen) options.listen(cb); else cb(); }
    address() { return { port: 12345 }; }
    on(name, cb) { if (name === 'error') this.errors.add(cb); else this.handlers[name] = cb; return this; }
    emitError(error) { for (const cb of [...this.errors]) cb(error); }
    close(cb) { if (options.notRunningWhileListening) { options.notRunningWhileListening = false; cb(Object.assign(Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' })); return; } if (options.closeError) { const error = options.closeError; options.closeError = undefined; throw error; } if (cb) this.closeCallbacks.push(cb); if (options.onClose) { const hook = options.onClose; options.onClose = undefined; hook(); } }
    finishClose() { for (const cb of this.closeCallbacks.splice(0)) cb(); }
    naturalClose() { this.handlers.close?.(); }
    request() { let finished; const done = new Promise(resolve => { finished = resolve; }); const res = { done, writeHead(status) { this.status = status; }, end() { finished(); } }; this.handlers.request({ method: 'GET', headers: { host: '127.0.0.1:12345' }, url: '/auth/callback?state=test&code=code' }, res); return res; }
  }
  class Store { readRegistrationSnapshot() { return { revision: 1, identity: { clientId: 'client' } }; } claimAuthorization() { claims++; return {}; } }
  class Attempt { url = 'https://example.invalid/?state=test'; consume() { return {}; } }
  const dependencies = {
    'node:http': { createServer: () => (server = options.createServer ? options.createServer() : new Server()) }, 'node:crypto': { randomUUID: () => 'flow' },
    express: { Router: () => ({ use() {}, post: (path, cb) => routes.set(`POST ${path}`, cb), get: (path, cb) => routes.set(`GET ${path}`, cb) }) },
    '../db/client.js': { getDb: () => db }, '../db/async-writer.js': { withAsyncWriter() { throw Error('unexpected writer'); } },
    '../utils/encryption.js': { CredentialVault: class {} }, './siwc-session.js': { getSiwcHostId: () => 'host', SiwcAttempt: Attempt },
    './siwc.js': { exchangeSiwcCode: async () => { exchanges++; if (options.exchange) return options.exchange(); throw Error('fixture'); }, SiwcInvalidGrantError: class extends Error {} }, './siwc-store.js': { SiwcStore: Store },
  };
  const exports = {};
  const sandbox = { exports, require: name => { if (!Object.hasOwn(dependencies, name)) throw Error('unexpected dependency'); return dependencies[name]; }, URL, URLSearchParams, AbortController, Date, Promise, setTimeout: (cb, delay) => { const timer = { cb, delay, at: now + delay, cleared: false, unref() {} }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.cleared = true; }, fetch: () => { throw Error('unexpected fetch'); } };
  const code = options.untracked ? compiled.replace('active.add(work);', '/* negative control: omit tracking */') : compiled;
  if (options.untracked) assert.notEqual(code, compiled, 'negative control must mutate tracking');
  vm.runInNewContext(code, sandbox, { timeout: 1000 });
  exports.createSiwcRouter(() => {});
  return { exports, routes, timers, advance(ms) { const end = now + ms; for (;;) { const due = timers.filter(t => !t.cleared && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; now = due.at; due.cleared = true; due.cb(); } now = end; }, get server() { return server; }, get claims() { return claims; }, get exchanges() { return exchanges; } };
}
function response() { return { status() { return this; }, json(value) { this.value = value; return this; } }; }
// Fails the test after 1s; it does not cancel the scenario itself. The fixture
// uses fake timers and no sockets, so an abandoned scenario holds no handles.
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture await timed out')), 1000); })]); }
  finally { clearTimeout(timer); }
}
const turn = () => bounded(new Promise(resolve => setImmediate(resolve)));

test('close throw rejects shutdown and explicit retry closes the same listener', async () => {
  const options = {}; const f = fixture(options);
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, response()));
  const original = f.server; options.closeError = Error('close failed');
  await bounded(assert.rejects(f.exports.stopSiwc()));
  const retry = f.exports.stopSiwc();
  await Promise.resolve();
  assert.equal(f.server, original);
  original.finishClose();
  await bounded(retry);
});

test('concurrent stops share closure and asynchronous close error requires retry', async () => {
  const f = fixture();
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, response()));
  const first = f.exports.stopSiwc();
  const second = f.exports.stopSiwc();
  assert.equal(first, second);
  assert.equal(f.server.closeCallbacks.length, 1);
  f.server.emitError(Error('close error'));
  await bounded(assert.rejects(first));
  const retry = f.exports.stopSiwc();
  assert.notEqual(retry, first);
  assert.equal(f.server.closeCallbacks.length, 2);
  f.server.finishClose();
  await bounded(retry);
});

test('shutdown deadline rejects without releasing pending callback ownership', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ exchange: () => gate });
  await bounded(f.routes.get('POST /start')({ body: { accountId: 'account' } }, response()));
  const callback = f.server.request();
  assert.equal(f.exchanges, 1);
  const first = f.exports.stopSiwc();
  const deadline = f.timers.filter(timer => timer.delay === 15000).at(-1);
  assert.ok(deadline);
  f.advance(14999);
  assert.equal(deadline.cleared, false);
  f.advance(1);
  await bounded(assert.rejects(first));
  const retry = f.exports.stopSiwc(); let settled = false;
  retry.then(() => { settled = true; }, () => { settled = true; });
  f.server.finishClose();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false);
  release({});
  await bounded(callback.done);
  await bounded(retry);
  assert.equal(f.exchanges, 1);
});

test('stop waits for an in-progress listen before closing its listener', async () => {
  let listening; const f = fixture({ listen: cb => { listening = cb; } });
  const start = f.routes.get('POST /start')({ body: { name: 'name' } }, response());
  const stop = f.exports.stopSiwc(); let settled = false;
  stop.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false);
  listening();
  await bounded(start);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  f.server.finishClose();
  await bounded(stop);
});

test('queued callback after shutdown fence cannot claim authorization', async () => {
  const f = fixture();
  await bounded(f.routes.get('POST /start')({ body: { accountId: 'account' } }, response()));
  const stopped = f.exports.stopSiwc();
  const res = f.server.request();
  f.server.finishClose();
  await bounded(stopped);
  await bounded(res.done);
  assert.equal(f.claims, 0, 'callback after stop must not claim authorization');
  assert.equal(f.exchanges, 0, 'callback after stop must not exchange');
  assert.notEqual(res.status, 200);
});

async function reentryScenario(untracked = false) {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const options = { exchange: () => gate, untracked };
  const f = fixture(options);
  await bounded(f.routes.get('POST /start')({ body: { accountId: 'account' } }, response()));
  let stopped; let settled = false;
  options.onClose = () => { stopped = f.exports.stopSiwc(); stopped.then(() => { settled = true; }, () => { settled = true; }); };
  const res = f.server.request();
  f.server.finishClose();
  // finishClose invokes the production close completion callback synchronously;
  // a full event-loop turn lets its promise and shutdown continuations run.
  await turn();
  assert.equal(f.exchanges, 1, 'fixture must enter the exchange');
  const premature = settled;
  release({});
  await bounded(stopped);
  await bounded(res.done);
  assert.equal(premature, false, 'stop must wait for the admitted callback');
}
test('synchronous close reentry drains the already admitted callback', async () => {
  await bounded(reentryScenario());
});
test('negative control detects missing active callback tracking', async () => {
  await assert.rejects(bounded(reentryScenario(true)), { message: 'stop must wait for the admitted callback\n\ntrue !== false\n' });
});

test('listener-only timeout retains ownership for explicit retry', async () => {
  const f = fixture();
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, response()));
  const original = f.server;
  const stop = f.exports.stopSiwc();
  let settled = false;
  stop.then(() => { settled = true; }, () => { settled = true; });
  f.advance(14999);
  await turn();
  assert.equal(settled, false);
  f.advance(1);
  await bounded(assert.rejects(stop, { message: 'SIWC shutdown timed out' }));
  const retry = f.exports.stopSiwc();
  assert.equal(f.server, original);
  assert.equal(original.closeCallbacks.length, 1, 'retry must retain the pending close');
  original.finishClose();
  await bounded(retry);
});

test('startup failure retains its listener until close completes', async () => {
  const f = fixture({ listen: () => { throw Error('synthetic startup failure'); } });
  const res = response();
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, res));
  assert.equal(res.value.error.message, 'Could not start sign-in');
  assert.equal(f.server.closeCallbacks.length, 1);
  const stop = f.exports.stopSiwc();
  f.server.finishClose();
  await bounded(stop);
});

test('natural close event alone does not confirm owned close callback', async () => {
  const f = fixture();
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, response()));
  f.server.naturalClose();
  const stop = f.exports.stopSiwc();
  assert.equal(f.server.closeCallbacks.length, 1);
  f.server.finishClose();
  await bounded(stop);
});

// Real Node semantics: closing a server whose listen never bound a handle reports
// ERR_SERVER_NOT_RUNNING. No socket is opened; listen fails synchronously.
test('real never-bound listener is released after startup failure so stop can complete', async () => {
  const http = require('node:http');
  let real;
  const f = fixture({ createServer: () => { real = http.createServer(); real.listen = () => { throw Error('synthetic startup failure'); }; return real; } });
  const res = response();
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, res));
  assert.equal(res.value.error.message, 'Could not start sign-in');
  assert.equal(real.listening, false);
  await turn();
  await bounded(f.exports.stopSiwc());
});

test('not-running report from a server still listening keeps the listener retained', async () => {
  const options = {}; const f = fixture(options);
  await bounded(f.routes.get('POST /start')({ body: { name: 'name' } }, response()));
  options.notRunningWhileListening = true;
  await bounded(assert.rejects(f.exports.stopSiwc(), { message: 'SIWC listener closure unconfirmed' }));
  const retry = f.exports.stopSiwc();
  await turn();
  f.server.finishClose();
  await bounded(retry);
});
