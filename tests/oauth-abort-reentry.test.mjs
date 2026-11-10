import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../src/upstream/oauth.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source + '\nexport const testAbortSignal = oauthAbort.signal;\n', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const servers = [], timers = [];
  const http = { createServer() {
    const server = {
      attempts: 0, connections: 0,
      once() {}, listen(_port, _host, ready) { this.ready = ready; },
      close(done) { this.attempts++; this.finishClose = done; },
      closeAllConnections() { this.connections++; },
    };
    servers.push(server); return server;
  } };
  const deps = { crypto, http, '../utils/logger.js': { logger: { info() {}, warn() {} } } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require(id) { if (!Object.hasOwn(deps, id)) throw Error('unexpected import'); return deps[id]; },
    process: { env: {} }, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout(fn) { timers.push(fn); return { unref() {} }; }, clearTimeout,
    fetch() { throw Error('network forbidden'); },
  }, { filename: 'oauth.ts' });
  return { oauth: module.exports, servers, timers };
}

for (const fail of [false, true]) {
  test(`abort listener reentry shares the ${fail ? 'rejecting' : 'successful'} stop`, { timeout: 2000 }, async () => {
    const { oauth, servers } = fixture();
    const start = oauth.startLogin('openai', { name: 'synthetic' });
    servers[0].ready(); await start;
    let nested, aborts = 0;
    oauth.testAbortSignal.addEventListener('abort', () => { aborts++; nested = oauth.stopOAuth(); });
    const unhandled = [];
    const record = error => unhandled.push(error);
    process.on('unhandledRejection', record);
    try {
      const stop = oauth.stopOAuth();
      // Attach handlers before assertions, including on the buggy distinct promise.
      const observed = Promise.allSettled([stop, nested]);
      await tick();
      assert.equal(nested, stop);
      assert.equal(oauth.stopOAuth(), stop);
      assert.equal(aborts, 1);
      assert.equal(servers[0].attempts, 1);
      assert.equal(servers[0].connections, 1);
      servers[0].finishClose(fail ? Error('synthetic') : undefined);
      const results = await observed;
      assert.deepEqual(results.map(x => x.status), [fail ? 'rejected' : 'fulfilled', fail ? 'rejected' : 'fulfilled']);
      if (fail) assert.match(results[0].reason.message, /close failed/);
      await tick();
      assert.deepEqual(unhandled, []);
    } finally { process.removeListener('unhandledRejection', record); }
  });
}

test('stale flow timer retries close but cannot turn a failed stop into success', { timeout: 2000 }, async () => {
  const { oauth, servers, timers } = fixture();
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  servers[0].ready(); await start;
  const first = oauth.stopOAuth();
  await tick(); servers[0].finishClose(Error('synthetic'));
  await assert.rejects(first, /close failed/);
  timers[0](); await tick();
  assert.equal(servers[0].attempts, 2);
  servers[0].finishClose(Error('synthetic'));
  await tick();
  await assert.rejects(first, /close failed/);
  const retry = oauth.stopOAuth();
  await tick(); assert.equal(servers[0].attempts, 3);
  servers[0].finishClose(); await retry;
});
