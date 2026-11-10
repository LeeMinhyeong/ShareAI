import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function compile(file, dependencies) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) { if (!(name in dependencies)) throw new Error('unexpected dependency'); return dependencies[name]; }, console: { info() {}, warn() {}, error() {}, debug() {} }, process: { env: {} }, Promise, AsyncLocalStorage, AbortController });
  return module.exports;
}
function fixture() {
  const routes = new Map(), calls = [];
  let onDb = () => {}, fail = false;
  const row = { id: 'fixture', name: 'Fixture', provider: 'openai', credentialStatus: 'available', status: 'active', priority: 0, weight: 1 };
  const touch = name => { calls.push(name); onDb(); if (fail) throw new Error('fixture failure'); };
  class Accounts { findByIdAdmin() { touch('find'); return row; } update() { touch('update'); } delete() { touch('delete'); } }
  class Usage { getAccountTodayStats() { touch('stats'); return {}; } findByAccount() { touch('logs'); return []; } }
  class Empty {}
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const work = compile('request-work.ts', { 'node:async_hooks': { AsyncLocalStorage } });
  const auth = compile('auth/user-auth.ts', { '../db/repositories/users.js': { UserRepository: Empty }, '../utils/encryption.js': {}, '../utils/logger.js': { logger }, '../config/env.js': { env: { ADMIN_API_KEY: 'fixture-key' } }, '../db/async-writer.js': {}, '../request-work.js': work });
  const router = { use() {}, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, put(path, ...handlers) { routes.set(`PUT ${path}`, handlers); }, patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); }, delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); } };
  compile('routes/admin.ts', { express: { Router: () => router }, '../auth/user-auth.js': auth, '../request-work.js': work, '../db/repositories/accounts.js': { AccountRepository: Accounts }, '../db/repositories/users.js': { UserRepository: Empty }, '../db/repositories/usage-logs.js': { UsageLogRepository: Usage }, '../db/repositories/settings.js': { SettingsRepository: Empty, STRATEGIES: [] }, '../utils/encryption.js': {}, '../utils/logger.js': { logger }, '../upstream/oauth.js': { setOnLoginComplete() {} }, '../upstream/siwc-login.js': { createSiwcRouter() { return () => {}; } }, './routing-snapshot.js': {} });
  function dispatch(method, authorization = 'Bearer fixture-key', fault = undefined) {
    const handlers = routes.get(`${method} /accounts/:id`);
    assert.ok(handlers, 'route missing');
    const req = { params: { id: 'fixture' }, body: {}, headers: authorization ? { authorization } : {} };
    const res = {
      statusCode: 200, statusCalls: [], jsonCalls: 0, endCalls: 0, destroyed: false,
      writableEnded: false, headersSent: false,
      status(n) { this.statusCalls.push(n); this.statusCode = n; return this; },
      json(body) { this.jsonCalls++; if (fault === 'json') throw new Error('synthetic response failure'); this.body = body; this.writableEnded = true; return this; },
      end() { this.endCalls++; if (fault === 'end') throw new Error('synthetic response failure'); this.writableEnded = true; return this; },
      destroy() { this.destroyed = true; },
    };
    let i = 0;
    const next = () => handlers[i++](req, res, next);
    next();
    return res;
  }
  return { work: work.requestWork, calls, dispatch, setOnDb(fn) { onDb = fn; }, setFail() { fail = true; } };
}

for (const method of ['GET', 'PATCH', 'DELETE']) {
  test(`${method}: normal, authentication and repository error`, () => {
    const f = fixture();
    assert.equal(f.dispatch(method, null).statusCode, 401);
    assert.equal(f.dispatch(method, 'Bearer incorrect').statusCode, 403);
    assert.equal(f.calls.length, 0);
    assert.equal(f.dispatch(method).statusCode, method === 'DELETE' ? 204 : 200);
    assert.ok(f.calls.length > 0);
    f.setFail();
    assert.equal(f.dispatch(method).statusCode, 500);
  });
  test(`${method}: rejects new work after shutdown`, async () => {
    const f = fixture();
    await f.work.stopAndDrain();
    const result = f.dispatch(method);
    assert.equal(result.statusCode, 503, 'shutdown must reject the request');
    assert.equal(f.calls.length, 0, 'shutdown request must not reach repository');
  });
  test(`${method}: owns in-flight database work until return`, { timeout: 3000 }, async () => {
    const f = fixture();
    let observed, drain;
    f.setOnDb(() => { if (!drain) { drain = f.work.stopAndDrain(); observed = f.work.active; } });
    f.dispatch(method);
    assert.ok(drain, 'repository checkpoint not reached');
    await drain;
    assert.equal(observed, 1, 'drain must retain the in-flight request');
  });
  test(`${method}: failed response does not start a second response`, { timeout: 3000 }, async () => {
    const f = fixture();
    const result = f.dispatch(method, 'Bearer fixture-key', method === 'DELETE' ? 'end' : 'json');
    assert.equal(result.destroyed, true);
    assert.equal(result.jsonCalls, method === 'DELETE' ? 0 : 1);
    assert.equal(result.endCalls, method === 'DELETE' ? 1 : 0);
    assert.deepEqual(result.statusCalls, method === 'DELETE' ? [204] : []);
    assert.equal(f.work.active, 0);
    await f.work.stopAndDrain();
  });
  test(`${method}: failed error response is not retried`, { timeout: 3000 }, async () => {
    const f = fixture();
    f.setFail();
    const result = f.dispatch(method, 'Bearer fixture-key', 'json');
    assert.equal(result.destroyed, true);
    assert.deepEqual(result.statusCalls, [500]);
    assert.equal(result.jsonCalls, 1);
    assert.equal(f.work.active, 0);
    await f.work.stopAndDrain();
  });
}
