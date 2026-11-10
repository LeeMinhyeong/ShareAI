import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../src/upstream/oauth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source + '\nexport const testOwnership = () => ({ callbackServer, closingServer, callbackClosing, callbackStarting }); export const testClose = closeCallbackServer;\n', {
  reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, strict: true },
});
assert.deepEqual(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), []);

function fixture(mode) {
  const servers = [];
  const deps = { crypto, http: { createServer() {
    const server = {
      attempts: 0, mode,
      once(_event, fn) { this.error = fn; },
      listen(_port, _host, ready) { this.ready = ready; },
      close(done) {
        this.attempts++;
        if (this.onClose) this.onClose();
        if (this.mode === 'throw') throw Error('synthetic');
        if (this.mode === 'async-error') { queueMicrotask(() => done(Error('synthetic'))); return; }
        this.finishClose = done;
      },
      closeAllConnections() {},
    };
    servers.push(server);
    return server;
  } }, '../utils/logger.js': { logger: { info() {}, warn() {} } } };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(id) { if (!Object.hasOwn(deps, id)) throw Error('unexpected import'); return deps[id]; },
    process: { env: {} }, Buffer, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout() { return { unref() {} }; }, clearTimeout,
    fetch() { throw Error('network forbidden'); },
  }, { filename: 'oauth.ts' });
  return { oauth: module.exports, servers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const mode of ['throw', 'async-error']) {
  test(`startup ${mode} close failure rejects stop and retains exact listener for retry`, { timeout: 2000 }, async () => {
    const { oauth, servers } = fixture(mode);
    const start = oauth.startLogin('openai', { name: 'synthetic' });
    const stop = oauth.stopOAuth();
    assert.equal(oauth.stopOAuth(), stop);
    servers[0].ready();
    assert.equal((await start).callbackListening, false);
    await assert.rejects(stop, /close failed/);
    assert.equal(oauth.testOwnership().closingServer, servers[0]);
    assert.equal(servers.length, 1);
    servers[0].mode = 'success';
    const retry = oauth.stopOAuth();
    assert.equal(oauth.stopOAuth(), retry);
    await tick();
    assert.equal(servers[0].attempts, 2);
    servers[0].finishClose();
    await retry;
    assert.equal(oauth.testOwnership().closingServer, null);
  });
}

test('persistent startup close failure rejects each explicit coalesced stop', { timeout: 2000 }, async () => {
  const { oauth, servers } = fixture('throw');
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  const stop = oauth.stopOAuth(); servers[0].ready(); await start;
  await assert.rejects(stop, /close failed/);
  const retry = oauth.stopOAuth(); assert.equal(retry, oauth.stopOAuth());
  await assert.rejects(retry, /close failed/);
  assert.equal(servers[0].attempts, 2);
  assert.equal(oauth.testOwnership().closingServer, servers[0]);
});

test('listen error during stop does not create or close a listener', { timeout: 2000 }, async () => {
  const { oauth, servers } = fixture('success');
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  const stop = oauth.stopOAuth(); servers[0].error(Error('synthetic'));
  assert.equal((await start).callbackListening, false);
  await stop;
  assert.equal(servers[0].attempts, 0);
  assert.equal(oauth.testOwnership().closingServer, null);
});

test('reentrant close shares stop and close attempt', { timeout: 2000 }, async () => {
  const { oauth, servers } = fixture('success');
  const start = oauth.startLogin('openai', { name: 'synthetic' });
  const stop = oauth.stopOAuth();
  let reentered;
  servers[0].onClose = () => { reentered = oauth.stopOAuth(); };
  servers[0].ready(); await start; await tick();
  assert.equal(reentered, stop);
  assert.equal(servers[0].attempts, 1);
  servers[0].finishClose(); await stop;
});

test('stop fences relisten already waiting on an older close', { timeout: 2000 }, async () => {
  const { oauth, servers } = fixture('success');
  const first = oauth.startLogin('openai', { name: 'synthetic' });
  servers[0].ready(); await first;
  oauth.testClose();
  const next = oauth.startLogin('openai', { name: 'synthetic' });
  const stop = oauth.stopOAuth();
  await tick();
  assert.equal(servers.length, 1);
  servers[0].finishClose();
  assert.equal((await next).callbackListening, false);
  await stop;
  assert.equal(servers.length, 1);
  assert.equal(oauth.testOwnership().closingServer, null);
});

test('fire-and-forget startup close failure is handled', { timeout: 2000 }, async () => {
  const { oauth, servers } = fixture('throw');
  const unhandled = [];
  const record = reason => unhandled.push(reason);
  process.on('unhandledRejection', record);
  let failure;
  let failed = false;
  try {
    const start = oauth.startLogin('openai', { name: 'synthetic' });
    const stop = oauth.stopOAuth();
    servers[0].ready(); await start;
    await tick(); await tick();
    assert.deepEqual(unhandled, []);
    await assert.rejects(stop, /close failed/);
  } catch (error) { failed = true; failure = error; }
  finally {
    try { process.removeListener('unhandledRejection', record); }
    catch (cleanup) { if (failed) throw new AggregateError([failure, cleanup]); throw cleanup; }
  }
  if (failed) throw failure;
});
