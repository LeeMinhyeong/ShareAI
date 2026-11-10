import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';

// Synthetic pre-router continuation; no real parser, server, socket or DB.
function load(path, modules) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const fakeEnv = new Proxy(Object.create(null), { get(target, key) {
    if (!Object.hasOwn(target, key)) throw new Error('Unexpected environment property');
    return target[key];
  } });
  const fakeProcess = new Proxy({ env: fakeEnv }, { get(target, key) {
    if (!Object.hasOwn(target, key)) throw new Error('Unexpected process property');
    return target[key];
  } });
  vm.runInNewContext(code, { exports, process: fakeProcess, require(name) {
    if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected import: ${name}`);
    return modules[name];
  } });
  return exports;
}
function harness(onCreate = () => {}, options = {}) {
  const work = load('../src/request-work.ts', { 'node:async_hooks': { AsyncLocalStorage } });
  const counts = { create: 0, auth: 0, keys: 0, other: 0 };
  class UserRepository {
    create(data) { counts.create++; onCreate(work.requestWork); return { id: 'id', ...data, enabled: true, createdAt: 'date' }; }
  }
  const logger = { info() {}, error(...args) { options.onError?.(...args); }, warn() {}, debug() { counts.auth++; } };
  const encryption = { generateApiKey() { counts.keys++; return 'synthetic-key'; }, hashApiKey() { return 'synthetic-hash'; } };
  const users = options.makeUsers ? options.makeUsers(work.requestWork) : { UserRepository };
  const auth = load('../src/auth/user-auth.ts', {
    '../db/repositories/users.js': users, '../utils/encryption.js': encryption,
    '../utils/logger.js': { logger }, '../config/env.js': { env: { ADMIN_API_KEY: 'admin-fixture' } },
    '../db/async-writer.js': {}, '../request-work.js': work,
  });
  const admin = load('../src/routes/admin.ts', {
    express, '../auth/user-auth.js': auth, '../db/repositories/users.js': users,
    '../db/repositories/accounts.js': { AccountRepository: class {} },
    '../db/repositories/usage-logs.js': { UsageLogRepository: class {} },
    '../db/repositories/settings.js': { SettingsRepository: class {}, STRATEGIES: [] },
    '../utils/encryption.js': encryption, '../utils/logger.js': { logger },
    '../upstream/oauth.js': { setOnLoginComplete() {} },
    '../upstream/siwc-login.js': { createSiwcRouter: () => express.Router() },
    './routing-snapshot.js': {}, '../request-work.js': work,
  });
  function prepare({ authorization, url = '/users', method = 'POST', body = { name: 'fixture', email: 'a@example.test' } } = {}) {
    const req = { method, url, headers: authorization ? { authorization } : {}, body };
    const res = { statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, headers: {},
      status(code) { this.statusCode = code; return this; }, set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      json(body) { options.onJson?.(body, this); this.body = body; this.headersSent = true; this.writableEnded = true; return this; },
      destroy() { this.destroyed = true; options.onDestroy?.(); } };
    return { res, continueParsing() { admin.default.handle(req, res, err => { options.onNext?.(); if (err) { if (options.onForward) return options.onForward(err); throw err; } counts.other++; }); } };
  }
  return { work: work.requestWork, counts, prepare };
}

test('late pre-router continuation is denied before user creation; authentication remains authoritative', async () => {
  const h = harness();
  const late = h.prepare({ authorization: 'Bearer admin-fixture' });
  const unauthorized = h.prepare();
  await bounded(h.work.stopAndDrain());
  late.continueParsing(); unauthorized.continueParsing();
  assert.equal(late.res.statusCode, 503);
  assert.equal(unauthorized.res.statusCode, 401);
  assert.deepEqual(h.counts, { create: 0, auth: 1, keys: 0, other: 0 });
});

test('invalid admin key remains 403 after shutdown; missing key remains 401', async () => {
  const h = harness();
  const invalid = h.prepare({ authorization: 'Bearer wrong-fixture' });
  const missing = h.prepare();
  try {
    await bounded(h.work.stopAndDrain());
    invalid.continueParsing(); missing.continueParsing();
    assert.equal(invalid.res.statusCode, 403);
    assert.equal(invalid.res.body.error.type, 'permission_denied');
    assert.equal(invalid.res.body.error.message, 'Invalid admin API key.');
    assert.equal(missing.res.statusCode, 401);
    assert.equal(missing.res.body.error.type, 'authentication_error');
    assert.deepEqual(h.counts, { create: 0, auth: 0, keys: 0, other: 0 });
  } finally { await bounded(h.work.stopAndDrain()); }
});

test('shutdown denial contains response failures without forwarding or creating users', async () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const faults = [new Error('synthetic-denial-secret'), revoked.proxy, undefined, null, false, 0];
  for (const stage of ['normal', 'status', 'json', 'destroy', 'headers-sent', 'ended']) {
    for (const fault of faults) {
      let next = 0, destroys = 0;
      const h = harness(() => {}, { onNext() { next++; }, onForward() {} });
      const request = h.prepare({ authorization: 'Bearer admin-fixture' });
      await bounded(h.work.stopAndDrain());
      if (stage === 'status') request.res.status = () => { throw fault; };
      if (stage === 'json' || stage === 'destroy' || stage === 'headers-sent' || stage === 'ended') {
        request.res.json = function () {
          if (stage === 'headers-sent') this.headersSent = true;
          if (stage === 'ended') this.writableEnded = true;
          throw fault;
        };
      }
      request.res.destroy = function () { destroys++; this.destroyed = true; if (stage === 'destroy') throw fault; };
      request.continueParsing();
      assert.equal(next, 0, 'nothing is forwarded to Express');
      assert.deepEqual(h.counts, { create: 0, auth: 1, keys: 0, other: 0 });
      assert.equal(destroys, stage === 'normal' || stage === 'ended' ? 0 : 1);
      if (stage === 'normal') {
        assert.equal(request.res.statusCode, 503);
        assert.equal(request.res.body.error.type, 'service_unavailable');
        assert.equal(request.res.body.error.message, 'Server is shutting down.');
        assert.equal(JSON.stringify(request.res.body).includes('synthetic-denial-secret'), false);
      } else {
        assert.equal(request.res.body, undefined);
      }
    }
  }
});

test('admitted create owns synchronous reentry until handler returns, without route collisions', async () => {
  let drain, nested, settled = false, settledAtMarker;
  const h = harness(manager => {
    drain = manager.stopAndDrain().then(() => { settled = true; });
    queueMicrotask(() => { settledAtMarker = settled; });
    nested = manager.run(() => { throw new Error('must not execute'); });
  });
  const create = h.prepare({ authorization: 'Bearer admin-fixture' });
  create.continueParsing();
  assert.equal(create.res.statusCode, 201);
  assert.equal(create.res.body.apiKey, 'synthetic-key');
  assert.equal(nested, undefined);
  assert.equal(settled, false);
  await bounded(drain);
  assert.equal(settledAtMarker, false, 'drain was already resolved during repository call');
  assert.equal(settled, true);
  const unrelated = h.prepare({ authorization: 'Bearer admin-fixture', url: '/not-a-route' });
  unrelated.continueParsing();
  assert.deepEqual(h.counts, { create: 1, auth: 1, keys: 1, other: 1 });
});

// The database is a synchronous, synthetic statement interpreter, not SQLite.
function realRepositoryCase(failure, options = {}) {
  const stages = [], observations = [], sql = [], logs = [];
  const secret = 'synthetic-failure-secret';
  let drain, settled = false, row, forwarded = false, manager, jsonMarker;
  const fault = Object.hasOwn(options, 'fault') ? options.fault : new Error(secret);
  const h = harness(() => {}, {
    onError(...entry) { logs.push(entry); if (options.loggerThrows) throw new Error(secret); },
    onForward() { forwarded = true; stages.push('forward'); },
    onJson(_body, res) {
      stages.push(`json:${res.statusCode}`);
      if (options.stopAtJson && res.statusCode === 201) {
        drain = manager.stopAndDrain().then(() => { settled = true; stages.push('drained'); });
        queueMicrotask(() => { jsonMarker = settled; });
      }
      if (failure === 'response' || (failure === 'response-twice' && res.statusCode === 500)) throw fault;
    },
    onDestroy() { stages.push('destroy'); if (options.destroyThrows) throw fault; },
    makeUsers(workManager) {
      manager = workManager;
      const db = { prepare(statement) {
        const normalized = statement.trim().replace(/\s+/g, ' ');
        sql.push(normalized);
        if (normalized.startsWith('INSERT INTO users ')) return { run(id, hash, name, email, tier, limit, created, updated) {
          stages.push('insert');
          if (!options.stopAtLookup && !options.stopAtJson) drain = manager.stopAndDrain().then(() => { settled = true; stages.push('drained'); });
          queueMicrotask(() => observations.push(['insert', settled]));
          if (failure === 'insert' || failure === 'response-twice' || options.headersSent) {
            if (options.headersSent) options.response.headersSent = true;
            throw fault;
          }
          row = { id, api_key_hash: hash, name, email, tier, daily_limit: limit, enabled: 1, created_at: created, updated_at: updated };
        } };
        if (normalized === 'SELECT * FROM users WHERE id = ?') return { get(id) {
          stages.push('lookup');
          if (options.stopAtLookup) drain = manager.stopAndDrain().then(() => { settled = true; stages.push('drained'); });
          queueMicrotask(() => observations.push(['lookup', settled]));
          if (failure === 'lookup') throw fault;
          return row?.id === id ? row : undefined;
        } };
        throw new Error('Unexpected synthetic statement');
      } };
      return load('../src/db/repositories/users.ts', {
        '../client.js': { getDb: () => db }, crypto: { randomUUID: () => 'fixture-id' },
      });
    },
  });
  return { h, stages, observations, sql, logs, secret, fault, get drain() { return drain; },
    get settled() { return settled; }, get forwarded() { return forwarded; }, get row() { return row; }, get jsonMarker() { return jsonMarker; } };
}

async function bounded(promise) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('drain deadline exceeded')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

test('201 response includes the complete one-time key payload and no-store', async () => {
  const c = realRepositoryCase('none');
  const request = c.h.prepare({ authorization: 'Bearer admin-fixture' });
  try { request.continueParsing(); }
  finally { await bounded(c.drain ?? c.h.work.stopAndDrain()); }
  assert.equal(request.res.statusCode, 201);
  assert.equal(request.res.headers['cache-control'] === 'no-store', true, '201 response must not be cached');
  const expected = { user: { id: 'fixture-id', name: 'fixture', email: 'a@example.test', tier: 'free',
    dailyLimit: 100, enabled: true, createdAt: c.row.created_at }, apiKey: 'synthetic-key' };
  assert.equal(JSON.stringify(request.res.body) === JSON.stringify(expected), true, '201 payload must match the complete expected shape');
  assert.equal(c.h.counts.keys, 1, 'exactly one synthetic key is generated');
});

test('shutdown started inside synchronous 201 json stays pending until response returns', async () => {
  const c = realRepositoryCase('none', { stopAtJson: true });
  const request = c.h.prepare({ authorization: 'Bearer admin-fixture' });
  try {
    request.continueParsing();
    assert.equal(request.res.statusCode, 201);
    assert.equal(request.res.writableEnded, true);
    assert.equal(Boolean(c.drain), true, 'json must start shutdown');
    assert.equal(c.settled, false);
  } finally { await bounded(c.drain ?? c.h.work.stopAndDrain()); }
  assert.equal(c.jsonMarker, false, 'drain must be pending when json invokes shutdown');
  assert.equal(c.settled, true);
  assert.deepEqual(c.stages, ['insert', 'lookup', 'json:201', 'drained']);
});

for (const failure of ['none', 'insert', 'lookup', 'response', 'response-twice']) {
  test(`real user repository: ${failure} keeps root until synchronous exit and drains`, async () => {
    const c = realRepositoryCase(failure);
    const request = c.h.prepare({ authorization: 'Bearer admin-fixture' });
    const expected = failure === 'insert' ? ['insert', 'json:500']
      : failure === 'lookup' ? ['insert', 'lookup', 'json:500']
      : failure === 'response' ? ['insert', 'lookup', 'json:201', 'destroy']
      : failure === 'response-twice' ? ['insert', 'json:500', 'destroy']
        : ['insert', 'lookup', 'json:201'];
    try {
      request.continueParsing();
      assert.deepEqual(c.stages, expected, 'dispatch must complete synchronously');
      assert.equal(c.settled, false);
      assert.ok(c.drain, 'stop must have been invoked from the real insert');
    } finally {
      await bounded(c.drain ?? c.h.work.stopAndDrain());
    }
    assert.deepEqual(c.stages, [...expected, 'drained']);
    assert.deepEqual(c.observations, failure === 'insert' || failure === 'response-twice' ? [['insert', false]] : [['insert', false], ['lookup', false]]);
    assert.deepEqual(c.sql, [
      'INSERT INTO users (id, api_key_hash, name, email, tier, daily_limit, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      ...(failure === 'insert' || failure === 'response-twice' ? [] : ['SELECT * FROM users WHERE id = ?']),
    ]);
    if (failure === 'none') {
      assert.equal(request.res.statusCode, 201);
      assert.equal(request.res.body.user.id, 'fixture-id');
      assert.equal(request.res.body.apiKey, 'synthetic-key');
    } else if (failure === 'insert' || failure === 'lookup') {
      assert.equal(request.res.statusCode, 500);
      assert.equal(request.res.body.error.type, 'internal_error');
      assert.equal(JSON.stringify(request.res.body).includes(c.secret), false, 'response contains synthetic secret');
    } else {
      assert.equal(request.res.destroyed, true);
    }
    assert.equal(c.forwarded, false, 'no error may escape to Express');
    if (failure !== 'none') {
      assert.equal(c.logs.length, 1);
      assert.equal(JSON.stringify(c.logs) === '[["Failed to create user"]]', true, 'log must contain only static diagnostic');
    }
  });
}

test('falsey and hostile thrown values never reach logs, output or Express', async () => {
  const hostile = new Proxy({}, { get() { throw new Error('synthetic-failure-secret'); }, getPrototypeOf() { throw new Error('synthetic-failure-secret'); } });
  for (const fault of [undefined, null, false, 0, hostile]) {
    const c = realRepositoryCase('insert', { fault, loggerThrows: true });
    const request = c.h.prepare({ authorization: 'Bearer admin-fixture' });
    try { request.continueParsing(); }
    finally { await bounded(c.drain ?? c.h.work.stopAndDrain()); }
    assert.equal(request.res.statusCode, 500);
    assert.equal(request.res.body.error.message, 'Failed to create user');
    assert.equal(JSON.stringify(request.res.body).includes(c.secret), false, 'response contains synthetic secret');
    assert.equal(JSON.stringify(c.logs) === '[["Failed to create user"]]', true, 'log must contain only static diagnostic');
    assert.equal(c.forwarded, false, 'no error may escape to Express');
  }
});

test('already-sent response is destroyed without another response or forwarded error', async () => {
  const options = { headersSent: true, destroyThrows: true };
  const c = realRepositoryCase('insert', options);
  const request = c.h.prepare({ authorization: 'Bearer admin-fixture' });
  options.response = request.res;
  try { request.continueParsing(); }
  finally { await bounded(c.drain ?? c.h.work.stopAndDrain()); }
  assert.deepEqual(c.stages, ['insert', 'destroy', 'drained']);
  assert.equal(request.res.destroyed, true);
  assert.equal(c.forwarded, false, 'no error may escape to Express');
});

test('null body produces a generic 500 and releases the root', async () => {
  const h = harness();
  const request = h.prepare({ authorization: 'Bearer admin-fixture', body: null });
  request.continueParsing();
  assert.equal(request.res.statusCode, 500);
  assert.equal(request.res.body.error.message, 'Failed to create user');
  await bounded(h.work.stopAndDrain());
});

test('reentrant shutdown at lookup waits for synchronous handler completion', async () => {
  const c = realRepositoryCase('none', { stopAtLookup: true });
  const request = c.h.prepare({ authorization: 'Bearer admin-fixture' });
  try {
    request.continueParsing();
    assert.deepEqual(c.stages, ['insert', 'lookup', 'json:201']);
    assert.equal(c.settled, false);
    assert.ok(c.drain);
    assert.equal(request.res.body.apiKey, 'synthetic-key');
  } finally {
    await bounded(c.drain ?? c.h.work.stopAndDrain());
  }
  assert.deepEqual(c.observations, [['insert', false], ['lookup', false]]);
  assert.deepEqual(c.stages, ['insert', 'lookup', 'json:201', 'drained']);
});
