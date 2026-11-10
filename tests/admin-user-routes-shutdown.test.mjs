import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The dispatcher and all third-party modules load only in a clean-env child.
if (process.argv[2] !== '--fixture') {
  test('admin user routes retain synchronous ownership through shutdown', async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture'], {
      env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let timedOut = false;
    let spawnFailed = false;
    let stage = 'startup';
    const stages = new Set(['startup', 'discovery', 'normal', 'payload', 'failure', 'validation', 'complete']);
    child.on('message', value => { if (stages.has(value)) stage = value; });
    child.on('error', () => { spawnFailed = true; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    const result = await new Promise(resolve => {
      const unconfirmed = setTimeout(() => resolve(null), 25000);
      child.once('close', (code, signal) => { clearTimeout(unconfirmed); resolve({ code, signal }); });
    });
    clearTimeout(timer);
    if (result === null) {
      try { child.disconnect(); } catch { /* The owned IPC channel may already be closed. */ }
      child.unref();
    }
    assert.ok(result !== null, `fixture close unconfirmed for owned child ${child.pid}; stage ${stage}`);
    assert.equal(timedOut, false, `fixture timed out; stage ${stage}`);
    assert.equal(spawnFailed, false, `fixture spawn failed; stage ${stage}`);
    assert.equal(result.code, 0, `fixture failed; stage ${stage}`);
  });
} else {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const express = require('express');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const randomUUID = () => 'synthetic-id';
  const root = new URL('../src/', import.meta.url);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const strict = values => new Proxy(Object.freeze(values), {
    get(target, key) {
      if (!own(target, key)) throw new Error(`unexpected fake property: ${String(key)}`);
      return target[key];
    },
  });
  const fakeProcess = strict({ env: strict({}) });
  function compile(relative, dependencies) {
    const source = readFileSync(new URL(relative, root), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    const restricted = name => {
      if (!own(dependencies, name)) throw new Error(`unexpected dependency: ${name}`);
      return dependencies[name];
    };
    const context = vm.createContext({ module, exports: module.exports, require: restricted, process: fakeProcess, console, Date, Promise, Error, Number, Boolean, Object, Array, Symbol, WeakMap, Set, AbortController });
    new vm.Script(output, { filename: relative }).runInContext(context);
    return module.exports;
  }
  const routes = [
    { method: 'POST', path: '/users', body: { name: 'Alice', email: 'a@example.test' }, status: 201 },
    { method: 'GET', path: '/users', status: 200 },
    { method: 'GET', path: '/users/u1', status: 200 },
    { method: 'PATCH', path: '/users/u1', body: { name: 'Updated' }, status: 200 },
  ];
  function fixture() {
    const events = [];
    let onDb = () => {}, onResponse = () => {}, onResult = (_name, result) => result;
    let row = { id: 'u1', api_key_hash: 'hash', name: 'Alice', email: 'a@example.test', tier: 'free', daily_limit: 100, enabled: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' };
    const touch = name => { events.push(name); onDb(); };
    const db = {
      function() { touch('function'); },
      prepare(sql) {
        touch('prepare');
        return {
          get() {
            touch('get');
            if (sql.includes('total_requests')) return { total_requests: 0, success_requests: 0, total_tokens: 0, uncertain: 0 };
            return row;
          },
          all() { touch('all'); return sql.includes('ORDER BY created_at') ? [row] : []; },
          safeIntegers() { return this; }, // usage history reads integers losslessly (findByUser)
          run(...values) {
            touch('run');
            if (sql.includes('INSERT INTO users')) row = { ...row, id: values[0], name: values[2], email: values[3] };
            if (sql.includes('UPDATE users')) row = { ...row, name: values[0] };
            return { changes: 1 };
          },
        };
      },
    };
    const users = compile('db/repositories/users.ts', { '../client.js': { getDb: () => { touch('getDb'); return db; } }, crypto: { randomUUID } });
    const usage = compile('db/repositories/usage-logs.ts', { '../client.js': { getDb: () => { touch('getDb'); return db; } }, crypto: { randomUUID }, '../usage-utc.js': { parseUsageUtc: () => null } });
    const calls = [];
    for (const [klass, names] of [[users.UserRepository, ['create', 'findAll', 'findById', 'update']], [usage.UsageLogRepository, ['getTodayStats', 'findByUser']]]) {
      for (const name of names) {
        const original = klass.prototype[name];
        klass.prototype[name] = function (...args) {
          calls.push([name, JSON.parse(JSON.stringify(args))]);
          return onResult(name, original.apply(this, args));
        };
      }
    }
    const work = compile('request-work.ts', { 'node:async_hooks': { AsyncLocalStorage } });
    const logger = { info() {}, warn() {}, debug() {}, error() {} };
    const encryption = { generateApiKey: () => 'synthetic-key', hashApiKey: () => 'hash' };
    const auth = compile('auth/user-auth.ts', { '../db/repositories/users.js': users, '../utils/encryption.js': encryption, '../utils/logger.js': { logger }, '../config/env.js': { env: Object.freeze({ ADMIN_API_KEY: 'synthetic-admin' }) }, '../db/async-writer.js': { withAsyncWriter() { throw new Error('unexpected writer'); } }, '../request-work.js': work });
    class EmptyRepository {}
    const admin = compile('routes/admin.ts', {
      express, '../auth/user-auth.js': auth, '../request-work.js': work,
      '../db/repositories/users.js': users, '../db/repositories/usage-logs.js': usage,
      '../db/repositories/accounts.js': { AccountRepository: EmptyRepository },
      '../db/repositories/settings.js': { SettingsRepository: EmptyRepository, STRATEGIES: [] },
      '../utils/encryption.js': encryption, '../utils/logger.js': { logger },
      '../upstream/oauth.js': { setOnLoginComplete() {} },
      '../upstream/siwc-login.js': { createSiwcRouter: () => (_req, _res, next) => next() },
      './routing-snapshot.js': {},
    });
    return { router: admin.default, work: work.requestWork, events, calls, logger, setMissing() { row = undefined; }, setOnDb(fn) { onDb = fn; }, setOnResult(fn) { onResult = fn; }, setOnResponse(fn) { onResponse = fn; }, response() { onResponse(); } };
  }
  function dispatch(f, route, authorization, fault = {}) {
    const headers = authorization ? { authorization } : {};
    const app = express();
    app.use('/admin', f.router);
    const url = `/admin${route.path}`;
    const req = Object.assign(Object.create(express.request), { app, method: route.method, url, originalUrl: url, headers, body: route.body || {} });
    const responseHeaders = Object.create(null);
    const res = Object.assign(Object.create(express.response), {
      req, app, statusCode: 200, locals: {}, finished: false,
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; return this; },
      getHeader(name) { return responseHeaders[name.toLowerCase()]; },
      end(value) { f.response(); this.body = value; this.finished = true; return this; },
      destroy() { this.destroyed = true; },
    });
    const responseCalls = { status: [], json: 0, destroy: 0 };
    let safeJson = true;
    const originalStatus = res.status, originalJson = res.json;
    res.status = function (status) { responseCalls.status.push(status); if (fault.status) throw new Error('synthetic-private-marker'); return originalStatus.call(this, status); };
    res.json = function (body) { responseCalls.json++; if (fault.checkFixed) safeJson = JSON.stringify(body) === JSON.stringify({ error: { type: 'internal_error', message: 'Failed to process admin user request' } }); if (fault.json) throw new Error('synthetic-private-marker'); return originalJson.call(this, body); };
    if (fault.headersSent) Object.defineProperty(res, 'headersSent', { get() { throw new Error('synthetic-private-marker'); } });
    if (fault.sent) Object.defineProperty(res, 'headersSent', { value: true });
    if (fault.writableEnded) Object.defineProperty(res, 'writableEnded', { get() { throw new Error('synthetic-private-marker'); } });
    res.destroy = () => { responseCalls.destroy++; if (fault.destroy) throw new Error('synthetic-private-marker'); };
    req.res = res;
    let nextCalled = false, escaped = false;
    try { app.handle(req, res, () => { nextCalled = true; }); } catch { escaped = true; }
    assert.equal(escaped, false, 'dispatcher must not throw');
    assert.equal(nextCalled, false, 'dispatcher must not forward errors');
    if (fault.expectDestroy) return { destroyed: responseCalls.destroy > 0, status: res.statusCode, responseCalls, safeJson };
    assert.equal(res.writableEnded, true, 'response must finish synchronously');
    return { status: res.statusCode, body: JSON.parse(res.body), responseCalls };
  }
  {
    process.send?.('discovery');
    const discovered = fixture().router.stack.filter(layer => layer.route && /^\/users(?:\/|$)/.test(layer.route.path))
      .flatMap(layer => Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${layer.route.path}`)).sort();
    assert.deepEqual(discovered, ['GET /users', 'GET /users/:id', 'PATCH /users/:id', 'POST /users']);
  }
  process.send?.('normal');
  for (const route of routes) {
    let normalBody, normalEvents;
    for (const [authorization, expected] of [[undefined, 401], ['Bearer wrong', 403]]) {
      const f = fixture();
      const result = dispatch(f, route, authorization);
      assert.equal(result.status, expected, `${route.method} ${route.path} auth`);
      assert.equal(f.events.length, 0, 'unauthorized must not access repository');
    }
    {
      const f = fixture();
      const result = dispatch(f, route, 'Bearer synthetic-admin');
      assert.equal(result.status, route.status, `${route.method} ${route.path} success`);
      normalBody = result.body;
      normalEvents = [...f.events];
      const expectedCalls = route.method === 'POST' ? [
        ['create', [{ apiKeyHash: 'hash', name: 'Alice', email: 'a@example.test', tier: 'free', dailyLimit: 100 }]], ['findById', ['synthetic-id']],
      ] : route.path === '/users' ? [['findAll', []]] : route.method === 'GET' ? [
        ['findById', ['u1']], ['getTodayStats', ['u1']], ['findByUser', ['u1', 20]],
      ] : [['findById', ['u1']], ['update', ['u1', { name: 'Updated' }]], ['findById', ['u1']]];
      assert.deepEqual(f.calls, expectedCalls, 'repository calls and arguments must match route contract');
      assert.ok(f.events.length > 0, 'success must access repository');
      const user = { id: route.method === 'POST' ? 'synthetic-id' : 'u1', name: route.method === 'PATCH' ? 'Updated' : 'Alice', email: 'a@example.test', tier: 'free', dailyLimit: 100, enabled: true, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
      let expected;
      if (route.method === 'POST') { const { updatedAt, ...created } = user; expected = { user: created, apiKey: 'synthetic-key' }; }
      else if (route.path === '/users') expected = { users: [user] };
      else if (route.method === 'GET') expected = { user, todayStats: { totalRequests: 0, successRequests: 0, totalTokens: 0, totalTokensComplete: true }, recentLogs: [] };
      else { const { createdAt, ...updated } = user; expected = { user: updated }; }
      assert.equal(JSON.stringify(result.body) === JSON.stringify(expected), true, 'success response must match contract');
      if (route.method === 'POST') assert.equal(result.body.apiKey, 'synthetic-key');
      else if (route.path === '/users') assert.equal(result.body.users[0].name, 'Alice');
      else assert.equal(result.body.user.name, route.method === 'PATCH' ? 'Updated' : 'Alice');
    }
    {
      const f = fixture();
      await f.work.stopAndDrain();
      assert.equal(dispatch(f, route, undefined).status, 401);
      assert.equal(dispatch(f, route, 'Bearer wrong').status, 403);
      const result = dispatch(f, route, 'Bearer synthetic-admin');
      assert.equal(result.status, 503, `${route.method} ${route.path} stopped`);
      assert.equal(f.events.length, 0, `${route.method} ${route.path} must not access repository after stop`);
    }
    for (let target = 0; target < normalEvents.length; target++) {
      const f = fixture();
      let drain, settled = false, callbackReturned = false, checkpoint, responseCheckpoint, index = 0;
      f.setOnDb(() => {
        if (index++ !== target) return;
        drain = f.work.stopAndDrain();
        drain.then(() => { settled = true; assert.equal(callbackReturned, true); });
        checkpoint = new Promise(resolve => queueMicrotask(() => { assert.equal(settled, false, 'drain must not have settled during repository callback'); resolve(); }));
        assert.equal(settled, false);
        callbackReturned = true;
      });
      f.setOnResponse(() => {
        let responseDrainSettled = false;
        f.work.stopAndDrain().then(() => { responseDrainSettled = true; });
        responseCheckpoint = new Promise(resolve => queueMicrotask(() => { assert.equal(responseDrainSettled, false, 'response must remain owned'); resolve(); }));
      });
      const result = dispatch(f, route, 'Bearer synthetic-admin');
      assert.equal(result.status, route.status, `${route.method} ${route.path} reentrant success`);
      assert.deepEqual(f.events, normalEvents, 'shutdown must not change repository operation sequence');
      if (route.method !== 'POST') assert.deepEqual(result.body, normalBody);
      else assert.equal(result.body.apiKey, normalBody.apiKey);
      assert.ok(drain, 'repository callback must trigger stop');
      await checkpoint;
      await responseCheckpoint;
      await drain;
      await Promise.resolve();
      assert.equal(settled, true);
    }
  }
  process.send?.('payload');
  for (const route of routes.slice(1)) {
    const f = fixture();
    let found = 0;
    f.setOnResult((name, result) => {
      if ((route.path === '/users' && name === 'findAll') ||
          (route.method === 'GET' && route.path !== '/users' && name === 'findByUser')) {
        found++;
        return new Proxy(result, { get(target, key, receiver) { if (key === 'map') throw new Error('synthetic-private-marker'); return Reflect.get(target, key, receiver); } });
      }
      if (route.method === 'PATCH' && name === 'findById' && ++found === 2) {
        return new Proxy(result, { get(target, key, receiver) { if (key === 'id') throw new Error('synthetic-private-marker'); return Reflect.get(target, key, receiver); } });
      }
      return result;
    });
    const result = dispatch(f, route, 'Bearer synthetic-admin');
    assert.equal(found, route.method === 'PATCH' ? 2 : 1, 'payload fault must be reached');
    assert.equal(result.status, 500, 'payload construction failure must return 500');
    assert.equal(JSON.stringify(result.body) === JSON.stringify({ error: { type: 'internal_error', message: 'Failed to process admin user request' } }), true, 'payload failure must return fixed diagnostic');
    assert.deepEqual(result.responseCalls, { status: [500], json: 1, destroy: 0 });
    await f.work.stopAndDrain();
    const dbCount = f.events.length;
    assert.equal(dispatch(f, route, 'Bearer synthetic-admin').status, 503);
    assert.equal(f.events.length, dbCount, 'stopped route must not access database');
  }
  process.send?.('failure');
  for (const route of routes.slice(1)) {
    {
      const f = fixture();
      const result = dispatch(f, route, 'Bearer synthetic-admin', { json: true, expectDestroy: true });
      assert.deepEqual(result.responseCalls, { status: [], json: 1, destroy: 1 }, 'success response failure must not retry');
      assert.equal(result.status, 200);
    }
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const thrown of [new Error('synthetic-private-marker'), null, false, undefined, 0, '', revoked.proxy]) {
      const f = fixture();
      f.setOnDb(() => { throw thrown; });
      let logged;
      f.logger.error = (...args) => { logged = args; throw new Error('synthetic-private-marker'); };
      const result = dispatch(f, route, 'Bearer synthetic-admin');
      assert.equal(result.status, 500, 'repository failure must return 500');
      assert.equal(JSON.stringify(result.body).includes('synthetic-private-marker'), false, 'response must not expose exception');
      assert.equal(JSON.stringify(result.body) === JSON.stringify({ error: { type: 'internal_error', message: 'Failed to process admin user request' } }), true, 'failure response must use fixed diagnostic');
      assert.equal(Array.isArray(logged) && logged.length === 1 && logged[0] === 'Failed to process admin user request', true, 'logger must receive only fixed diagnostic');
    }
    for (const fault of [{ json: true }, { status: true }, { headersSent: true }, { sent: true }, { json: true, writableEnded: true }, { json: true, writableEnded: true, destroy: true }]) {
      const f = fixture();
      f.setOnDb(() => { throw null; });
      let logged;
      f.logger.error = (...args) => { logged = args; };
      const result = dispatch(f, route, 'Bearer synthetic-admin', { ...fault, checkFixed: true, expectDestroy: true });
      assert.equal(result.destroyed, true, 'response failure must attempt destruction');
      assert.equal(result.safeJson, true, '500 response must not expose the thrown value');
      assert.equal(Array.isArray(logged) && logged.length === 1 && logged[0] === 'Failed to process admin user request', true, 'logger must receive only fixed diagnostic');
      assert.deepEqual(result.responseCalls, { status: fault.headersSent || fault.sent ? [] : [500], json: fault.status || fault.headersSent || fault.sent ? 0 : 1, destroy: 1 });
      assert.equal(result.status, fault.status || fault.headersSent || fault.sent ? 200 : 500);
      await f.work.stopAndDrain();
      const dbCount = f.events.length;
      assert.equal(dispatch(f, route, 'Bearer synthetic-admin').status, 503);
      assert.equal(f.events.length, dbCount, 'stopped route must not access database');
    }
    {
      const f = fixture();
      await f.work.stopAndDrain();
      const result = dispatch(f, route, 'Bearer synthetic-admin', { status: true, writableEnded: true, destroy: true, expectDestroy: true });
      assert.equal(result.destroyed, true, 'denial failure must attempt destruction');
      assert.equal(f.events.length, 0, 'denial must not touch database');
    }
  }
  process.send?.('validation');
  for (const route of routes.slice(2)) {
    const f = fixture(); f.setMissing();
    assert.equal(dispatch(f, route, 'Bearer synthetic-admin').status, 404, 'missing user must return 404');
  }
  for (const body of [{ dailyLimit: -1 }, { enabled: 'yes' }]) {
    const f = fixture();
    assert.equal(dispatch(f, { ...routes[3], body }, 'Bearer synthetic-admin').status, 400, 'invalid patch must return 400');
    assert.equal(f.events.length, 0, 'invalid patch must not touch database');
  }
  process.send?.('complete');
}
