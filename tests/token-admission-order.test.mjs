import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
function load(file, deps, globals = {}) {
  const code = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Promise, AbortController, ...globals })((name) => {
    if (!Object.hasOwn(deps, name)) throw new Error(`Unexpected dependency: ${name}`);
    return deps[name];
  }, mod, mod.exports);
  return mod.exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const events = [], logs = [], capturedConsole = [], signals = new Map(), attempts = [], reentryAccepting = [], reentryEvents = [], gates = { claim: deferred(), provider: deferred(), store: deferred(), mark: deferred() };
  const trace = name => { if (options.trace) events.push(name); };
  const creds = { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: Date.now() + 1000 };
  const account = { id: 'synthetic', name: 'synthetic', status: 'active', provider: 'openai', credentialType: 'oauth', credentialRevision: 1, credentials: JSON.stringify(creds) };
  let claims = 0, providers = 0, stores = 0, marks = 0, callback, timer, cleared = false, exits = 0, exitArgument, startup, initCalls=0, expiryStarts=0, expiryStops=0;
  let intent = false, persisted = false, now = 0, due, retainedClaim, firstClaim;
  const claimInputs = [], finishInputs = [], markInputs = [], conflicts = [];
  const matchesClaim = (claim, id, expected, revision) => !!claim && claim.account.id === id && claim.inputCredentials === expected && claim.account.credentialRevision === revision;
  const work = load('src/request-work.ts', { 'node:async_hooks': require('node:async_hooks') });
  const requestStop = work.requestWork.stopAndDrain.bind(work.requestWork);
  work.requestWork.stopAndDrain = () => { trace('request-attempt'); const result = requestStop(); if (options.fail === 'request') throw false; return result; };
  const logger = {
    info(...args) { logs.push(['info', ...args]); if (args[1] === 'Shutting down gracefully') { trace('logger-info'); invoke('logger'); } },
    error(...args) { logs.push(['error', ...args]); trace('logger-error'); invoke('error'); },
  };
  class RefreshIntentError extends Error { constructor() { super('refresh intent retained'); } }
  class AccountRepository {
    findById() { return account; }
    claimRefresh(id, expected, db, expectedRevision) {
      claims++; events.push('claim');
      claimInputs.push({ id, expected, db, expectedRevision });
      const conflict = intent && matchesClaim(retainedClaim, id, expected, expectedRevision);
      conflicts.push(conflict);
      if (options.retainIntent && conflict) throw new RefreshIntentError();
      const claim = { account: { ...account }, credentialVersion: 'synthetic-version', fingerprint: 'synthetic-fingerprint', attemptId: 'synthetic-attempt' };
      firstClaim ??= claim;
      retainedClaim = { ...claim, inputCredentials: expected };
      intent = true;
      return claim;
    }
    finishRefresh(id, credentialVersion, credentialRevision, fingerprint, attemptId, credentials, meta, db) {
      finishInputs.push({ id, credentialVersion, credentialRevision, fingerprint, attemptId, credentials, meta, db });
      stores++; events.push('store'); if (options.fail === 'store') throw new Error('synthetic-secret-store-error'); persisted = true; intent = false; return account;
    }
    markRefreshError(id, credentialVersion, observed, db) { markInputs.push({ id, credentialVersion, observed, db }); marks++; events.push('mark'); }
    hasRefreshIntent() { return intent; }
  }
  let writerCalls = 0;
  const tokens = load('src/upstream/tokens.ts', {
    '../db/repositories/accounts.js': { AccountRepository, RefreshIntentError },
    '../db/async-writer.js': { async withAsyncWriter(fn) { const call = ++writerCalls; if (call === 3) events.push('mark-wait'); await (call === 1 || call > 3 ? gates.claim.promise : call === 2 ? gates.store.promise : gates.mark.promise); return fn({}); } },
    '../utils/logger.js': { logger },
    './oauth.js': { parseStoredCredentials: JSON.parse, decodeJwt: () => undefined, async refreshTokens() { providers++; events.push('provider'); await gates.provider.promise; return { accessToken: 'new', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600000 }; } },
  }, { console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => capturedConsole.push([method, ...args])])) });
  const actualTokenDrain = tokens.drainTokenRefreshes.bind(tokens);
  tokens.drainTokenRefreshes = () => {
    if (options.fail === 'token-before' || options.fail === 'token-after') {
      events.push('token-attempt');
      if (options.fail === 'token-after') void actualTokenDrain();
      throw false;
    }
    trace('token-attempt');
    const drain = actualTokenDrain();
    if (!options.observeDrain) return drain;
    return drain.then(() => { events.push('drain-settled'); }, () => { events.push('drain-rejected'); throw new Error('token drain failed'); });
  };
  function invoke(name) {
    if (options.reenter === name && attempts.length === 0) {
      reentryAccepting.push(work.requestWork.isAccepting());
      reentryEvents.push([...events]);
      attempts.push(tokens.resolveAuth(account).then(() => 'fulfilled', error => error.message));
      signals.get('SIGINT')();
    }
  }
  const process = { exitCode: 0, on(name, fn) { signals.set(name, fn); }, exit(code) { exits++; exitArgument = code; } };
  const express = Object.assign(() => ({ all() {}, use() {}, get() {}, listen(_port,_host,cb) { startup=cb; return {
    on() {},
    close(cb) { events.push('listener'); callback = cb; }, closeAllConnections() { events.push('force'); },
  }; } }), { json: () => () => {} });
  const stop = name => { events.push(name); invoke(name); if (options.fail === name) throw false; return Promise.resolve(); };
  load('src/server.ts', {
    express, './http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js': { env: {} }, './utils/logger.js': { logger },
    './upstream/oauth.js': { stopOAuth: () => stop('oauth') },
    './upstream/siwc-login.js': { stopSiwc: () => stop('siwc'), noStoreSiwc() {} },
    './upstream/tokens.js': tokens, './request-work.js': work,
    './db/client.js': { initDatabase() {initCalls++;}, requireInitializedDatabase() {}, closeDatabase() { events.push('db'); } },
    './db/async-writer.js': { retryQuarantinedWriters() { events.push('writers'); } },
    './db/account-429-v2-store.js': { assert429V2Schema() {} },
    './db/account-429-v2-expiry.js': { Account429V2Expiry: class { start() {expiryStarts++;} stopAndDrain() {expiryStops++; return Promise.resolve(); } } },
    './routes/v1.js': { __esModule: true, default() {} }, './routes/admin.js': { __esModule: true, default() {} },
  }, { process, setTimeout(fn, ms) { assert.equal(ms, 5000); due = now + ms; timer = fn; return {unref(){events.push('unref');}}; }, clearTimeout() { cleared = true; } });
  assert.equal(typeof startup,'function'); startup();
  assert.equal(initCalls,1); assert.equal(expiryStarts,1); assert.equal(process.exitCode,0);
  return { tokens, account, events, logs, capturedConsole, signals, attempts, reentryAccepting, reentryEvents, gates, process, actualTokenDrain, claimInputs, finishInputs, markInputs, conflicts, matchesClaim,
    get retainedClaim() { return retainedClaim; }, get firstClaim() { return firstClaim; },
    close: () => { const cb = callback; callback = undefined; cb(); },
    releaseListener: () => { if (callback) { const cb = callback; callback = undefined; cb(); } },
    stopRequestWork: requestStop, clearFakeTimer: () => { timer = undefined; },
    fire: () => { assert.equal(due, 5000); now = due; timer(); assert.equal(now, 5000); },
    get counts() { return [claims, providers, stores]; }, get marks() { return marks; }, get intent() { return intent; }, get persisted() { return persisted; },
    get cleared() { return cleared; }, get exits() { return exits; }, get expiryStops() {return expiryStops;}, get exitArgument() { return exitArgument; } };
}

async function withCleanup(f, body) {
  let failed = false, original;
  try { await body(); } catch (error) { failed = true; original = error; }
  finally {
   try {
    for (const gate of Object.values(f.gates)) gate.resolve();
    f.releaseListener();
    f.clearFakeTimer();
    const pending = Promise.all([f.stopRequestWork(), f.actualTokenDrain(), ...f.attempts]);
    let timer;
    try {
      await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('synthetic cleanup timed out')), 1000); })]);
    } finally { clearTimeout(timer); }
  } catch (error) {
    if (failed) throw new AggregateError([original, error], 'test and synthetic cleanup failed');
    throw error;
   }
  }
  if (failed) throw original;
}

for (const hook of ['logger', 'oauth', 'siwc']) {
  test(`token admission closes before reentrant ${hook}`, { timeout: 2000 }, async () => {
    const f = fixture({ reenter: hook });
    await withCleanup(f, async () => {
    f.signals.get('SIGTERM')();
    assert.equal(f.expiryStops,1);
    f.close();
    // Unblock any incorrectly admitted refresh, ensuring a red test never hangs.
    f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve();
    assert.equal(f.attempts.length, 1);
    assert.equal((await f.attempts[0]) === 'Token refresh unavailable during shutdown', true, 'reentrant refresh must be refused');
    await flush();
    assert.deepEqual(f.counts, [0, 0, 0]);
    assert.deepEqual(f.events, ['oauth', 'siwc', 'listener', 'unref']);
    assert.equal(f.cleared, false);
    });
  });
}

test('a pre-admitted refresh holds shutdown through claim, provider and persistence', { timeout: 2000 }, async () => {
  const f = fixture({ observeDrain: true });
  await withCleanup(f, async () => {
  const task = f.tokens.resolveAuth(f.account).then(value => value.token === 'new', () => false);
  await flush();
  f.signals.get('SIGTERM')(); f.close(); await flush();
  assert.equal(f.expiryStops,1);
  assert.deepEqual(f.counts, [0, 0, 0]); assert.equal(f.events.includes('db'), false); assert.equal(f.events.includes('unref'), false); assert.equal(f.events.includes('drain-settled'), false);
  f.gates.claim.resolve(); await flush();
  assert.deepEqual(f.counts, [1, 1, 0]); assert.equal(f.events.includes('db'), false); assert.equal(f.events.includes('unref'), false); assert.equal(f.events.includes('drain-settled'), false);
  f.gates.provider.resolve(); await flush();
  assert.deepEqual(f.counts, [1, 1, 0]); assert.equal(f.events.includes('db'), false); assert.equal(f.events.includes('unref'), false); assert.equal(f.events.includes('drain-settled'), false);
  f.gates.store.resolve(); assert.equal(await task, true, 'refresh must return the synthetic new token'); await flush();
  assert.deepEqual(f.counts, [1, 1, 1]);
  assert.deepEqual(f.events.slice(-3), ['store', 'drain-settled', 'unref']); assert.equal(f.events.includes('db'), false); assert.equal(f.events.includes('writers'), false); assert.equal(f.cleared, false);
  });
});

for (const failedHook of ['request', 'siwc']) {
test(`falsey ${failedHook} failure still closes token admission and keeps deadline armed`, { timeout: 2000 }, async () => {
  const f = fixture({ fail: failedHook, reenter: 'error' });
  await withCleanup(f, async () => {
  f.signals.get('SIGTERM')(); f.close();
  f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve();
  await flush();
  assert.equal(f.attempts.length, 1);
  assert.equal(await f.attempts[0], 'Token refresh unavailable during shutdown');
  await flush(); assert.deepEqual(f.counts, [0, 0, 0]);
  assert.equal(f.events.includes('oauth'), true); assert.equal(f.events.includes('siwc'), true);
  assert.equal(f.events.includes('db'), false); assert.equal(f.cleared, false); assert.equal(f.process.exitCode, 1);
  f.fire(); assert.equal(f.exits, 1); assert.equal(f.events.includes('force'), true);
  });
});
}

for (const stage of ['before', 'after']) {
  test(`token drain falsey throw ${stage} actual closure preserves deadline despite logger reentry`, { timeout: 2000 }, async () => {
    const f = fixture({ fail: `token-${stage}`, reenter: 'error', trace: true });
    try {
      f.signals.get('SIGTERM')(); f.close(); await flush();
      assert.equal(f.events.includes('token-attempt'), true);
      assert.deepEqual(f.reentryAccepting, [false]);
      assert.deepEqual(f.reentryEvents[0], ['request-attempt', 'token-attempt', 'logger-info', 'oauth', 'siwc', 'listener', 'logger-error']);
      assert.equal(f.attempts.length, 1);
      assert.equal(f.process.exitCode, 1);
      assert.equal(f.cleared, false);
      assert.equal(f.events.includes('db'), false);
      if (stage === 'before') {
        // The real admission barrier was never invoked: logger reentry can start a flight.
        f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve();
        assert.equal(await f.attempts[0], 'fulfilled');
        assert.deepEqual(f.counts, [1, 1, 1]);
      } else {
        assert.equal((await f.attempts[0]) === 'Token refresh unavailable during shutdown', true, 'reentrant refresh must be refused');
        assert.deepEqual(f.counts, [0, 0, 0]);
      }
      await flush();
      assert.equal(f.events.includes('db'), false);
      assert.equal(f.cleared, false);
      f.fire();
      assert.equal(f.exits, 1); assert.equal(f.exitArgument, 1);
      assert.equal(f.events.includes('force'), true); assert.equal(f.events.includes('db'), false);
    } finally {
      f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve(); f.gates.mark.resolve();
      await f.actualTokenDrain();
      await Promise.all(f.attempts);
    }
  });
}

test('failed persistence holds token drain through error marking before deadline unref', { timeout: 2000 }, async () => {
  const f = fixture({ fail: 'store', observeDrain: true });
  const result = f.tokens.resolveAuth(f.account).then(() => 'unexpected success', error => error.message);
  try {
    await flush(); f.signals.get('SIGTERM')(); f.close();
    f.events.push('release-claim'); f.gates.claim.resolve(); await flush();
    assert.deepEqual(f.counts, [1, 1, 0]);
    assert.equal(f.intent, true); assert.equal(f.events.includes('db'), false);
    f.events.push('release-provider'); f.gates.provider.resolve(); await flush();
    assert.deepEqual(f.counts, [1, 1, 0]); assert.equal(f.events.includes('db'), false); assert.equal(f.events.includes('unref'), false);
    f.events.push('release-store'); f.gates.store.resolve(); await flush();
    assert.deepEqual(f.counts, [1, 1, 1]); assert.equal(f.marks, 0);
    assert.equal(f.events.includes('mark-wait'), true);
    assert.equal(f.intent, true); assert.equal(f.persisted, false);
    assert.equal(f.events.includes('db'), false); assert.equal(f.events.includes('unref'), false); assert.equal(f.cleared, false);
    f.events.push('release-mark'); f.gates.mark.resolve();
    assert.equal(await result, 'OAuth token refresh failed; reauthentication may be required');
    await flush();
    assert.equal(f.marks, 1); assert.equal(f.intent, true); assert.equal(f.persisted, false);
    assert.deepEqual(f.counts, [1, 1, 1]);
    assert.deepEqual(f.events, ['oauth', 'siwc', 'listener', 'release-claim', 'claim', 'provider', 'release-provider', 'release-store', 'store', 'mark-wait', 'release-mark', 'mark', 'drain-settled', 'unref']);
    assert.equal(f.events.filter(event => event === 'db').length, 0);
    assert.equal(f.events.filter(event => event === 'writers').length, 0);
    const tokenLogs = f.logs.filter(args => args[1] && args[2] === 'OAuth token refresh failed');
    assert.equal(tokenLogs.length, 1);
    assert.equal(!JSON.stringify([f.logs, f.capturedConsole]).includes('synthetic-secret-store-error'), true, 'output must not contain the synthetic secret');
    assert.equal(f.cleared, false); assert.equal(f.process.exitCode, 0);
  } catch {
    throw new Error('persistence failure regression check failed');
  } finally {
    f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve(); f.gates.mark.resolve();
    await result;
    await f.actualTokenDrain();
  }
});

test('retained synthetic intent blocks a second exchange without shutdown', { timeout: 2000 }, async () => {
  // This fake CAS demonstrates module coordination, not durable SQLite fencing.
  const f = fixture({ fail: 'store', retainIntent: true });
  const first = f.tokens.resolveAuth(f.account).then(() => false, error => error.message === 'OAuth token refresh failed; reauthentication may be required');
  try {
    f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve(); f.gates.mark.resolve();
    assert.equal(await first, true, 'first failure must be sanitized');
    assert.equal(f.intent, true); assert.equal(f.persisted, false); assert.equal(f.marks, 1);
    const claim = f.firstClaim, retained = f.retainedClaim;
    const firstInput = f.claimInputs[0], finish = f.finishInputs[0], mark = f.markInputs[0];
    assert.equal(claim.account.id === 'synthetic' && claim.account.credentialRevision === 1 &&
      claim.credentialVersion === 'synthetic-version' && claim.fingerprint === 'synthetic-fingerprint' &&
      claim.attemptId === 'synthetic-attempt', true, 'first returned synthetic claim must contain the expected tuple');
    assert.equal(firstInput.id === 'synthetic' && firstInput.expected === f.account.credentials &&
      firstInput.expectedRevision === 1 && claim.account.credentials === firstInput.expected, true, 'first claim inputs must match the original account');
    assert.equal(finish.id === claim.account.id && finish.credentialVersion === claim.credentialVersion &&
      finish.credentialRevision === claim.account.credentialRevision && finish.fingerprint === claim.fingerprint &&
      finish.attemptId === claim.attemptId, true, 'finish must use the returned claim tuple');
    assert.equal(mark.id === claim.account.id && mark.credentialVersion === claim.credentialVersion &&
      mark.observed === claim.account, true, 'error marking must use the claimed account and credential version');
    assert.equal(retained.account === claim.account && retained.credentialVersion === claim.credentialVersion &&
      retained.fingerprint === claim.fingerprint && retained.attemptId === claim.attemptId, true, 'error marking must retain the original tuple');
    assert.equal(f.matchesClaim(retained, 'different-account', firstInput.expected, 1), false, 'different account is not the same identity');
    assert.equal(f.matchesClaim(retained, firstInput.id, 'different-credentials', 1), false, 'different credentials are not the same identity');
    assert.equal(f.matchesClaim(retained, firstInput.id, firstInput.expected, 2), false, 'different revision is not the same identity');
    const second = await f.tokens.resolveAuth(f.account).then(() => false, error => error.message === 'refresh intent retained');
    assert.equal(second, true, 'retained intent must reject the next claim');
    const replay = f.claimInputs[1];
    assert.equal(replay.id === firstInput.id && replay.expected === firstInput.expected &&
      replay.expectedRevision === firstInput.expectedRevision && f.conflicts[0] === false && f.conflicts[1] === true,
      true, 'replay must reach the fake repository with the original identity and conflict');
    assert.equal(f.retainedClaim === retained && retained.fingerprint === 'synthetic-fingerprint' &&
      retained.attemptId === 'synthetic-attempt', true, 'replay must leave the retained fingerprint and attempt unchanged');
    assert.deepEqual(f.counts, [2, 1, 1]);
    assert.deepEqual(f.events, ['claim', 'provider', 'store', 'mark-wait', 'mark', 'claim']);
    assert.equal(f.logs.filter(args => args[2] === 'OAuth token refresh failed').length, 1);
    assert.equal(!JSON.stringify([f.logs, f.capturedConsole]).includes('synthetic-secret-store-error'), true, 'output must not contain the synthetic secret');
  } catch {
    throw new Error('retained intent regression check failed');
  } finally {
    f.gates.claim.resolve(); f.gates.provider.resolve(); f.gates.store.resolve(); f.gates.mark.resolve();
    await first;
    await f.actualTokenDrain();
  }
});
