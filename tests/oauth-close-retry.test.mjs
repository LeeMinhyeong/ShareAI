import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function fixture() {
  const servers = [];
  const http = { createServer(handler) {
    const server = {
      handler, attempts: 0,
      listen(_port, _host, ready) { this.ready = ready; },
      once() {},
      close(done) { this.attempts++; if (this.mode === 'alwaysThrow' || (this.mode === 'firstThrow' && this.attempts === 1)) throw Error('synthetic failure'); this.closed = done; },
      closeAllConnections() {},
    };
    servers.push(server);
    return server;
  } };
  const source = readFileSync(new URL('../src/upstream/oauth.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const deps = { crypto, http, '../utils/logger.js': { logger: { info() {}, warn() {} } } };
  let now = 0;
  class FakeDate extends Date { static now() { return now; } }
  const context = { module, exports: module.exports, require(id) { if (!Object.hasOwn(deps, id)) throw Error('unexpected import'); return deps[id]; }, process: { env: {} }, Date: FakeDate, Buffer, URL, URLSearchParams, AbortController, AbortSignal, setTimeout() { return { unref() {} }; }, clearTimeout, fetch() { throw Error('network forbidden'); } };
  vm.runInNewContext(code, context, { filename: 'oauth.ts' });
  return { oauth: module.exports, servers, advance(ms) { now += ms; } };
}

test('a failed listener close remains owned and a later stop retries it', async () => {
  const { oauth, servers } = fixture();
  const starting = oauth.startLogin('openai', { name: 'synthetic' });
  servers[0].mode = 'firstThrow';
  servers[0].ready();
  assert.equal((await starting).callbackListening, true);
  await assert.rejects(oauth.stopOAuth(), /close failed/);
  const retry = oauth.stopOAuth();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers[0].attempts, 2, 'must retry the same uncertain listener');
  servers[0].closed();
  await retry;
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('asynchronous failures retain ownership and concurrent stops share each attempt', async () => {
  const { oauth, servers } = fixture();
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  servers[0].ready(); await start;
  const first = oauth.stopOAuth();
  assert.equal(first, oauth.stopOAuth());
  await tick();
  servers[0].closed(Error('synthetic secret'));
  await assert.rejects(first, e => /close failed/.test(e.message) && !e.message.includes('synthetic secret'));
  const second = oauth.stopOAuth();
  assert.equal(second, oauth.stopOAuth());
  await tick(); assert.equal(servers[0].attempts, 2);
  servers[0].closed(); await second;
});

test('persistent close failure never reports success', async () => {
  const { oauth, servers } = fixture();
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  servers[0].mode = 'alwaysThrow'; servers[0].ready(); await start;
  await assert.rejects(oauth.stopOAuth(), /close failed/);
  await assert.rejects(oauth.stopOAuth(), /close failed/);
  assert.equal(servers[0].attempts, 2);
  assert.equal(servers.length, 1);
});

test('relisten waits for a confirmed retry of an asynchronously failed close', async () => {
  const { oauth, servers, advance } = fixture();
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  servers[0].ready(); const first = await start;
  advance(600001); oauth.getFlow(first.flowId);
  await tick(); servers[0].closed(Error('synthetic'));
  await tick();
  const next = oauth.startLogin('openai', { name: 'synthetic' });
  await tick();
  assert.equal(servers[0].attempts, 2);
  assert.equal(servers.length, 1);
  servers[0].closed(); await tick();
  assert.equal(servers.length, 2);
  servers[1].ready(); assert.equal((await next).callbackListening, true);
  const stop = oauth.stopOAuth(); await tick(); servers[1].closed(); await stop;
});

test('stop during startup closes its eventual listener and fences callbacks', async () => {
  const { oauth, servers } = fixture();
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  const stop = oauth.stopOAuth();
  assert.equal(stop, oauth.stopOAuth());
  servers[0].ready();
  assert.equal((await start).callbackListening, false);
  await tick();
  const response = { status: 0, setHeader() {}, writeHead(status) { this.status = status; return this; }, end() {} };
  await servers[0].handler({ url: '/auth/callback?state=synthetic&code=synthetic' }, response);
  assert.equal(response.status, 400);
  servers[0].closed(); await stop;
  await assert.rejects(oauth.startLogin('openai', { name: 'synthetic' }), /shutting down/);
});
