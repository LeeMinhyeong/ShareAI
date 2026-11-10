import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);
const compiled = new Map();

// All application modules are evaluated from explicitly named sources and their
// dependencies must be in this own-property allowlist. No application config or
// DB client is loaded; the child starts with an empty environment.
function fixture() {
  const ts = require('typescript');
  const express = require('express');
  let manager;
  const calls = [];
  const logs = [];
  const writes = [];
  const reads = [];
  let hook = () => {};
  const stage = name => { calls.push(name); hook(name); };
  const db = { prepare(sql) {
    stage('prepare');
    if (!['SELECT key, value FROM settings', 'SELECT value FROM settings WHERE key = ?', 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'].includes(sql)) throw new Error('unexpected-sql');
    return {
      all() { if (sql !== 'SELECT key, value FROM settings') throw new Error('unexpected-sql'); stage('all'); return [{ key: 'strategy.openai', value: 'priority' }]; },
      get(key) { if (sql !== 'SELECT value FROM settings WHERE key = ?') throw new Error('unexpected-sql'); reads.push(key); stage('get'); return key === 'strategy.openai' ? { value: 'round_robin' } : undefined; },
      run(key, value) { if (!sql.startsWith('INSERT INTO settings ')) throw new Error('unexpected-sql'); writes.push([key, value]); stage('run'); },
    };
  } };
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])]));
  const load = (relative, imports) => {
    if (!compiled.has(relative)) {
      const source = readFileSync(resolve(root, relative), 'utf8');
      compiled.set(relative, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    }
    const code = compiled.get(relative);
    const exports = {};
    const localRequire = id => {
      if (!Object.hasOwn(imports, id)) throw new Error('unapproved import');
      return imports[id];
    };
    vm.runInThisContext(`(function(require, exports, module) {${code}\n})`, { filename: relative })(localRequire, exports, { exports });
    return exports;
  };
  const work = load('src/request-work.ts', { 'node:async_hooks': require('node:async_hooks') });
  manager = work.requestWork;
  const settings = load('src/db/repositories/settings.ts', { '../client.js': { getDb: () => { stage('getDb'); return db; } } });
  class EmptyRepo {}
  const auth = load('src/auth/user-auth.ts', {
    '../db/repositories/users.js': { UserRepository: EmptyRepo },
    '../utils/encryption.js': { hashApiKey() {} },
    '../utils/logger.js': { logger },
    '../config/env.js': { env: { ADMIN_API_KEY: 'fixture-admin' } },
    '../db/async-writer.js': { withAsyncWriter() {} },
    '../request-work.js': work,
  });
  const router = load('src/routes/admin.ts', {
    express,
    '../auth/user-auth.js': auth,
    '../request-work.js': work,
    '../db/repositories/users.js': { UserRepository: EmptyRepo },
    '../db/repositories/accounts.js': { AccountRepository: EmptyRepo },
    '../db/repositories/usage-logs.js': { UsageLogRepository: EmptyRepo },
    '../utils/encryption.js': { generateApiKey() {}, hashApiKey() {} },
    '../utils/logger.js': { logger },
    '../upstream/oauth.js': { setOnLoginComplete() {} },
    '../db/repositories/settings.js': settings,
    '../upstream/siwc-login.js': { createSiwcRouter: () => express.Router() },
    './routing-snapshot.js': { routingSnapshot() {} },
  }).default;
  function dispatch(method, url, body, authorization = 'Bearer fixture-admin', fault = '') {
    const req = new EventEmitter();
    Object.assign(req, { method, url, originalUrl: url, baseUrl: '', headers: authorization ? { authorization } : {}, body });
    const res = new EventEmitter();
    const structured = typeof fault === 'object' && fault !== null;
    Object.assign(res, { statusCode: 200, headersSent: structured && !!fault.headersSent, writableEnded: false, destroyed: false });
    res.responseCalls = [];
    res.faultHits = 0;
    const inject = name => {
      if (structured && fault.target === name) { res.faultHits++; throw fault.value; }
      if (structured && fault.precursor === name) throw new Error('fixture-precursor-private-error');
    };
    res.status = function(code) { this.responseCalls.push(['status', code]); inject('status'); if (fault === 'status' || fault === 'status-destroy') throw new Error('fixture-private-error'); this.statusCode = code; return this; };
    res.json = function(payload) { this.responseCalls.push(['json', payload]); stage('json'); inject('json'); if (fault === 'json' || fault === 'json-destroy') throw new Error('fixture-private-error'); this.payload = payload; this.headersSent = true; this.writableEnded = true; return this; };
    res.destroy = function() { this.responseCalls.push(['destroy']); inject('destroy'); if (!structured && fault.endsWith('-destroy')) throw new Error('fixture-private-error'); this.destroyed = true; };
    res.nextCalls = 0;
    router.handle(req, res, () => { res.nextCalls++; });
    return res;
  }
  return { manager, calls, logs, writes, reads, dispatch, setHook(value) { hook = value; } };
}

function check(value, label) { if (!value) throw new Error(label); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function boundedDrain(drain) {
  let timer;
  try {
    await Promise.race([drain, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('drain-timeout')), 100);
    })]);
  } finally { clearTimeout(timer); }
}

async function verifyReleased(manager) {
  // Inspect the real manager synchronously, before stopping admission.
  let activeError;
  try { check(manager.active === 0, 'early-root-retained'); } catch (error) { activeError = error; }
  let drainError;
  try { await boundedDrain(manager.stopAndDrain()); } catch (error) { drainError = error; }
  if (activeError) throw activeError;
  if (drainError) throw drainError;
}

async function child() {
  for (const scenario of [
    { method: 'GET', url: '/settings', body: undefined, stages: ['getDb', 'prepare', 'all', 'json'], payload: { settings: { 'strategy.openai': 'priority' } } },
    { method: 'GET', url: '/settings/strategy/openai', body: undefined, stages: ['getDb', 'prepare', 'get', 'json'], reads: ['strategy.openai'], payload: { provider: 'openai', strategy: 'round_robin' } },
    { method: 'GET', url: '/settings/strategy/unknown-provider', body: undefined, stages: ['getDb', 'prepare', 'get', 'json'], reads: ['strategy.unknown-provider'], payload: { provider: 'unknown-provider', strategy: 'priority' } },
    { method: 'PUT', url: '/settings/strategy/openai', body: { strategy: 'round_robin' }, stages: ['getDb', 'prepare', 'run', 'json'], payload: { provider: 'openai', strategy: 'round_robin' } },
  ]) {
    for (const target of scenario.stages) {
      for (const mutant of [false, true]) {
        const f = fixture();
        let observed = 0;
        let ownership = false;
        let drain;
        f.setHook(name => {
          if (name !== target) return;
          observed++;
          drain = f.manager.stopAndDrain();
          // Test-only premature-release mutant: exactly the same assertion is
          // evaluated after the real manager has stopped and lost its root.
          if (mutant) {
            // The wrapper's acquired root is released by the captured scope.
            release();
          }
          ownership = f.manager.active === 1;
        });
        let release = () => {};
        if (mutant) {
          const previous = f.manager.ownedDispatch.bind(f.manager);
          f.manager.ownedDispatch = dispatch => previous(scope => { release = scope.terminal; dispatch(scope); });
        }
        const response = f.dispatch(scenario.method, scenario.url, scenario.body);
        check(observed === 1, 'stage-count');
        let ownershipFailure;
        try { check(ownership, 'ownership-lost'); } catch (error) { ownershipFailure = error; }
        if (mutant) check(ownershipFailure instanceof Error && ownershipFailure.message === 'ownership-lost', 'mutant-not-detected');
        else if (ownershipFailure) throw ownershipFailure;
        check(response.statusCode === 200 && same(response.payload, scenario.payload), 'success-payload');
        check(response.nextCalls === 0, 'call-sequence');
        check(same(f.calls, scenario.stages), 'call-sequence');
        check(same(f.reads, scenario.reads || []), 'call-sequence');
        check(same(f.writes, scenario.method === 'PUT' ? [['strategy.openai', 'round_robin']] : []), 'call-sequence');
        check(f.manager.active === 0, 'root-not-released');
        await boundedDrain(drain);
      }
    }
    for (const [authorization, status, payload] of [
      ['', 401, { error: { type: 'authentication_error', message: 'Missing admin API key.' } }],
      ['Bearer fixture-hostile-secret', 403, { error: { type: 'permission_denied', message: 'Invalid admin API key.' } }],
    ]) {
      const f = fixture();
      let ownedCalls = 0;
      const ownedDispatch = f.manager.ownedDispatch.bind(f.manager);
      f.manager.ownedDispatch = dispatch => { ownedCalls++; return ownedDispatch(dispatch); };
      const res = f.dispatch(scenario.method, scenario.url, scenario.body, authorization);
      check(res.statusCode === status && same(res.payload, payload) && same(res.responseCalls, [['status', status], ['json', payload]]) && same(f.calls, ['json']) && same(f.reads, []) && same(f.writes, []) && res.nextCalls === 0 && ownedCalls === 0, 'auth-boundary');
      check(!JSON.stringify([res.responseCalls, f.logs]).includes('fixture-hostile-secret'), 'safe-failure');
      await verifyReleased(f.manager);
    }
    const stopped = { error: { type: 'service_unavailable', message: 'Server is shutting down.' } };
    for (const fault of ['', 'status', 'json', 'status-destroy', 'json-destroy']) {
      const f = fixture();
      await f.manager.stopAndDrain();
      const res = f.dispatch(scenario.method, scenario.url, scenario.body, undefined, fault);
      const expected = fault.startsWith('status') ? [['status', 503], ['destroy']]
        : fault.startsWith('json') ? [['status', 503], ['json', stopped], ['destroy']]
        : [['status', 503], ['json', stopped]];
      check(same(res.responseCalls, expected) && same(f.calls, fault.startsWith('status') ? [] : ['json']) && same(f.reads, []) && same(f.writes, []) && res.nextCalls === 0 && f.manager.active === 0, 'stopped-boundary');
      check(fault ? res.payload === undefined && res.destroyed === !fault.endsWith('-destroy') : res.statusCode === 503 && same(res.payload, stopped) && !res.destroyed, 'stopped-payload');
      check(!JSON.stringify([res.responseCalls, f.logs]).includes('fixture-private-error'), 'safe-failure');
    }
  }
  // Exercise the actual authenticated strategy reader with hostile thrown values
  // at each reachable response boundary, including failures during termination.
  const hostileValues = [
    () => null, () => undefined, () => false, () => 0, () => '',
    () => { const pair = Proxy.revocable({}, {}); pair.revoke(); return pair.proxy; },
    () => new Error('fixture-response-private-error'),
  ];
  const stoppedPayload = { error: { type: 'service_unavailable', message: 'Server is shutting down.' } };
  const errorPayload = { error: { type: 'internal_error', message: 'Failed to process admin settings request' } };
  const successPayload = { provider: 'openai', strategy: 'round_robin' };
  const responseCases = [
    { mode: 'stopped', target: 'status', expected: [['status', 503], ['destroy']] },
    { mode: 'stopped', target: 'json', expected: [['status', 503], ['json', stoppedPayload], ['destroy']] },
    { mode: 'stopped', target: 'destroy', precursor: 'status', expected: [['status', 503], ['destroy']] },
    { mode: 'stopped', target: 'destroy', precursor: 'json', expected: [['status', 503], ['json', stoppedPayload], ['destroy']] },
    { mode: 'db', target: 'status', expected: [['status', 500], ['destroy']] },
    { mode: 'db', target: 'json', expected: [['status', 500], ['json', errorPayload], ['destroy']] },
    { mode: 'db', target: 'destroy', precursor: 'status', expected: [['status', 500], ['destroy']] },
    { mode: 'db', target: 'destroy', precursor: 'json', expected: [['status', 500], ['json', errorPayload], ['destroy']] },
    { mode: 'db', target: 'destroy', headersSent: true, expected: [['destroy']] },
    ...[false, true].flatMap(headersSent => [
      { mode: 'success', target: 'json', headersSent, expected: [['json', successPayload], ['destroy']] },
      { mode: 'success', target: 'destroy', precursor: 'json', headersSent, expected: [['json', successPayload], ['destroy']] },
    ]),
  ];
  for (const scenario of responseCases) for (const makeValue of hostileValues) {
    const f = fixture();
    let dbFailures = 0;
    if (scenario.mode === 'stopped') await boundedDrain(f.manager.stopAndDrain());
    if (scenario.mode === 'db') f.setHook(name => {
      if (name === 'prepare') { dbFailures++; throw new Error('fixture-db-private-error'); }
    });
    const r = f.dispatch('GET', '/settings/strategy/openai', undefined, undefined,
      { target: scenario.target, precursor: scenario.precursor, headersSent: scenario.headersSent, value: makeValue() });
    const expectedCalls = scenario.mode === 'stopped' ? [] : scenario.mode === 'db' ? ['getDb', 'prepare'] : ['getDb', 'prepare', 'get'];
    if (scenario.expected.some(call => call[0] === 'json')) expectedCalls.push('json');
    check(r.faultHits === 1 && dbFailures === (scenario.mode === 'db' ? 1 : 0), 'hostile-response');
    check(same(r.responseCalls, scenario.expected) && same(f.calls, expectedCalls) &&
      same(f.reads, scenario.mode === 'success' ? ['strategy.openai'] : []) && same(f.writes, []) &&
      r.nextCalls === 0 && r.payload === undefined && !r.writableEnded &&
      r.headersSent === !!scenario.headersSent && r.destroyed === (scenario.target !== 'destroy'), 'hostile-response');
    const expectedLogs = scenario.mode === 'stopped' ? [['debug', 'Admin authenticated']] :
      [['debug', 'Admin authenticated'], ['error', 'Failed to process admin settings request']];
    check(same(f.logs, expectedLogs) && !JSON.stringify([r.responseCalls, f.logs]).includes('fixture-') , 'hostile-response');
    await verifyReleased(f.manager);
  }
  for (const scenario of [
    { url: '/settings/strategy/openai', body: { strategy: 'fixture-hostile-secret' }, status: 400,
      payload: { error: { type: 'invalid_request', message: 'Invalid strategy. Use one of: round_robin, priority, least_used' } },
      calls: ['json'], writes: [] },
    { url: '/settings/strategy/unknown-provider', body: { strategy: 'round_robin' }, status: 200,
      payload: { provider: 'unknown-provider', strategy: 'round_robin' },
      calls: ['getDb', 'prepare', 'run', 'json'], writes: [['strategy.unknown-provider', 'round_robin']] },
  ]) {
    for (const mutant of [false, true]) {
      const f = fixture();
      let retainedScope;
      let interceptedTerminals = 0;
      let cleanups = 0;
      if (mutant) {
        const ownedDispatch = f.manager.ownedDispatch.bind(f.manager);
        f.manager.ownedDispatch = dispatch => ownedDispatch(scope => {
          check(!retainedScope, 'mutant-scope-count');
          retainedScope = scope;
          dispatch({ ...scope, terminal() { interceptedTerminals++; } });
        });
      }
      try {
        const r = f.dispatch('PUT', scenario.url, scenario.body);
        check(r.statusCode === scenario.status && same(r.payload, scenario.payload) &&
          same(r.responseCalls, scenario.status === 400 ? [['status', 400], ['json', scenario.payload]] : [['json', scenario.payload]]) &&
          same(f.calls, scenario.calls) && same(f.writes, scenario.writes) && r.nextCalls === 0, 'validation');
        check(!JSON.stringify([r.responseCalls, f.logs]).includes('fixture-hostile-secret'), 'safe-failure');
        let failure;
        try { await verifyReleased(f.manager); } catch (error) { failure = error; }
        if (mutant) {
          check(retainedScope && interceptedTerminals === 1 && f.manager.active === 1, 'mutant-scope-count');
          check(failure instanceof Error && failure.message === 'early-root-retained', 'mutant-not-detected');
          let drainFailure;
          try { await boundedDrain(f.manager.stopAndDrain()); } catch (error) { drainFailure = error; }
          check(drainFailure instanceof Error && drainFailure.message === 'drain-timeout', 'mutant-drain-not-detected');
        } else if (failure) throw failure;
      } finally {
        if (retainedScope) { cleanups++; retainedScope.terminal(); }
        await boundedDrain(f.manager.stopAndDrain());
        check(f.manager.active === 0 && cleanups === (mutant ? 1 : 0), 'mutant-cleanup');
      }
    }
  }
  for (const scenario of [
    { method: 'GET', url: '/settings', body: undefined },
    { method: 'GET', url: '/settings/strategy/openai', body: undefined },
    { method: 'PUT', url: '/settings/strategy/openai', body: { strategy: 'round_robin' } },
  ]) {
    const payload = { error: { type: 'internal_error', message: 'Failed to process admin settings request' } };
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const fault of ['', 'status', 'json', 'status-destroy', 'json-destroy']) for (const thrown of [new Error('fixture-private-error'), undefined, null, false, 0, revoked.proxy]) {
      const f = fixture();
      f.setHook(name => { if (name === 'prepare') throw thrown; });
      const r = f.dispatch(scenario.method, scenario.url, scenario.body, undefined, fault);
      const expected = fault.startsWith('status') ? [['status', 500], ['destroy']]
        : fault.startsWith('json') ? [['status', 500], ['json', payload], ['destroy']]
        : [['status', 500], ['json', payload]];
      check(same(f.calls, fault.startsWith('status') ? ['getDb', 'prepare'] : ['getDb', 'prepare', 'json']) && same(f.writes, []) && same(r.responseCalls, expected) && r.nextCalls === 0 && f.manager.active === 0, 'safe-failure');
      check(fault ? r.payload === undefined && r.destroyed === !fault.endsWith('-destroy') : r.statusCode === 500 && same(r.payload, payload) && !r.destroyed, 'safe-failure');
      check(same(f.logs, [['debug', 'Admin authenticated'], ['error', 'Failed to process admin settings request']]) && !JSON.stringify([r.responseCalls, f.logs]).includes('fixture-private-error'), 'safe-failure');
    }
  }
}

if (process.argv.includes('--fixture-child')) {
  try { await child(); process.stdout.write('fixture-pass\n'); }
  catch (error) {
    const allowed = new Set(['stage-count', 'mutant-not-detected', 'ownership-lost', 'success-payload', 'call-sequence', 'root-not-released', 'auth-boundary', 'stopped-boundary', 'stopped-payload', 'validation', 'safe-failure', 'early-root-retained', 'drain-timeout', 'mutant-scope-count', 'mutant-drain-not-detected', 'mutant-cleanup']);
    allowed.add('hostile-response');
    let label = 'fixture-error';
    try { if (error instanceof Error && allowed.has(error.message)) label = error.message; } catch { /* Hostile values stay private. */ }
    process.stderr.write(`${label}\n`);
    process.exitCode = 1;
  }
} else {
  test('settings sync ownership and shutdown admission', { timeout: 20000 }, async () => {
    await new Promise((resolvePromise, reject) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-child'], { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = ''; let err = ''; let timedOut = false; let spawnError = false;
      p.on('error', () => { spawnError = true; });
      p.stdout.on('error', () => {}); p.stderr.on('error', () => {});
      p.stdout.on('data', chunk => { out = (out + chunk.toString()).slice(0, 1024); });
      p.stderr.on('data', chunk => { err = (err + chunk.toString()).slice(0, 1024); });
      let closeWatch;
      const timer = setTimeout(() => {
        timedOut = true;
        try { p.kill(); } catch { /* close must still be observed */ }
        closeWatch = setTimeout(() => reject(new Error('child-close-unconfirmed')), 3000);
      }, 10000);
      p.on('close', code => {
        clearTimeout(timer);
        clearTimeout(closeWatch);
        if (!timedOut && !spawnError && code === 0 && out === 'fixture-pass\n' && err === '') resolvePromise();
        else {
          const labels = ['stage-count', 'mutant-not-detected', 'ownership-lost', 'success-payload', 'call-sequence', 'root-not-released', 'auth-boundary', 'stopped-boundary', 'stopped-payload', 'validation', 'safe-failure', 'early-root-retained', 'drain-timeout', 'mutant-scope-count', 'mutant-drain-not-detected', 'mutant-cleanup'];
          labels.push('hostile-response');
          reject(new Error(!timedOut && labels.includes(err.trim()) ? err.trim() : 'child-failed-or-unconfirmed'));
        }
      });
    });
  });
}
