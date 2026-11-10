// Real Express routing, authentication, repository and memory-writer; no listeners or real config.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript'), express = require('express'), Database = require('better-sqlite3');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, dependencies = {}) {
  let input = read(path);
  if (process.argv[2] === 'bad-day' && path.endsWith('/repositories/users.ts')) input = input.replace('(now ?? new Date()).toISOString().slice(0, 10)', "'1999-01-01'");
  if (process.argv[2] === 'no-model-auth' && path.endsWith('/routes/v1.ts')) {
    const original = "router.get('/models', ownedEndpoint(false,";
    const replacement = "router.get('/models', trackedRoute(";
    assert.equal(input.split(original).length - 1, 1, 'model auth mutation must match exactly once');
    input = input.replace(original, replacement);
    process.send?.('mutation-applied');
  }
  const source = ts.transpileModule(input, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${source}\n})`)(exports, name => {
    if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected fixture dependency');
    return dependencies[name];
  });
  return exports;
}
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline')), 2000); })]).finally(() => clearTimeout(timer));
}
function response() {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, destroyed: false, writableEnded: false, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.writableEnded = true; finish(); return this; },
    destroy() { this.destroyed = true; finish(); },
  });
  return {res, done};
}

async function fixture() {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2031-07-01T00:00:00.123Z'])); }
    static now() { return RealDate.parse('2031-07-01T00:00:00.123Z'); }
  };
  const db = new Database(':memory:');
  let manager, drainPromise, drained = false, primary = false, cleanup = false;
  const drain = () => drainPromise ??= Promise.resolve().then(() => manager.stopAndDrain());
  const check = (condition, category = 'other') => { if (!condition) throw new Error(category); };
  try {
    const schema = load('../src/db/schema.ts');
    db.exec(schema.SQL_SCHEMA);
    // This migration-owned table is not part of SQL_SCHEMA; extract its production DDL.
    const migration = read('../src/db/client.ts').match(/CREATE TABLE IF NOT EXISTS user_daily_quota \([\s\S]*?\n\s*\);/);
    check(Boolean(migration));
    db.exec(migration[0]);
    db.pragma('foreign_keys = ON');
    const loggerEntries = [];
    const logger = Object.fromEntries(['debug','warn','error'].map(level => [level, (...args) => loggerEntries.push(args)]));
    const client = {getDb: () => db, requireInitializedDatabase: () => db};
    const users = load('../src/db/repositories/users.ts', {'../client.js': client, crypto: require('crypto')});
    const encryption = load('../src/utils/encryption.ts', {crypto: require('crypto'), '../config/env.js': {env: {}}});
    const writer = load('../src/db/async-writer.ts', {'better-sqlite3': Database, './client.js': client, '../utils/logger.js': {logger}});
    const work = load('../src/request-work.ts', {'node:async_hooks': require('node:async_hooks')});
    manager = new work.RequestWorkManager();
    const auth = load('../src/auth/user-auth.ts', {'../db/repositories/users.js': users, '../utils/encryption.js': encryption, '../utils/logger.js': {logger}, '../config/env.js': {env: {}}, '../db/async-writer.js': writer, '../request-work.js': {requestWork: manager}});
    const repo = new users.UserRepository();
    const key = 'synthetic-v1-key-not-a-credential', wrong = 'synthetic-wrong-key';
    const user = repo.create({apiKeyHash: encryption.hashApiKey(key), name:'Synthetic', email:'synthetic@example.invalid', tier:'free', dailyLimit:1});
    const counts = () => db.prepare('SELECT user_id, day, used FROM user_daily_quota').all();
    const quota = used => check(JSON.stringify(counts()) === JSON.stringify(used ? [{user_id:user.id, day:'2031-07-01', used}] : []), 'utc');
    let calls = 0, selections = 0, throwForward = false;
    const responses = [];
    const router = load('../src/routes/v1.ts', {express, '../config/env.js': {env: {NODE_ENV: 'test'}}, '../auth/user-auth.js': auth, '../request-work.js': {requestWork: manager}, '../utils/logger.js': {logger}, '../upstream/forward-chat.js': {forwardChat: (req, res) => {
      calls++;
      check(req.user?.id === user.id);
      // Simulated pre-dispatch selection and reselection, not the production selector.
      selections += 2;
      if (throwForward) throw new Error(key);
      res.json({ok:true});
    }}}).default;
    async function request(method, url, headers = {}) {
      const {res, done} = response();
      const req = {method, url, headers};
      const outer = work.trackedErrorHandler((error, _req, response) => response.status(500).json({error:{message:error.message}}), manager);
      router.handle(req, res, error => { if (error) outer(error, req, res, () => {}); else res.status(404).json({}); });
      await bounded(done);
      responses.push(res.body);
      return res;
    }
    const bearer = value => ({authorization:`Bearer ${value}`});
    const routes = [['GET','/models'], ['POST','/messages'], ['POST','/chat/completions']];
    for (const [method, url] of routes) {
      check((await request(method, url)).statusCode === 401, 'auth');
      check((await request(method, url, bearer(wrong))).statusCode === 401, 'auth');
    }
    repo.update(user.id, {enabled:false});
    for (const [method, url] of routes) check((await request(method, url, bearer(key))).statusCode === 401, 'auth');
    quota(0); check(calls === 0);
    repo.update(user.id, {enabled:true, dailyLimit:0});
    check((await request('POST','/chat/completions',bearer(key))).statusCode === 429);
    quota(0);
    check(calls === 0);
    check((await request('GET','/models', {'x-api-key':key})).statusCode === 200);
    quota(0);
    check((await request('POST','/messages',bearer(key))).statusCode === 429);
    repo.update(user.id, {dailyLimit:1});
    check((await request('POST','/chat/completions',bearer(key))).statusCode === 200);
    check(calls === 1);
    check(selections === 2);
    quota(1);
    check(db.inTransaction === false);
    check((await request('POST','/chat/completions',bearer(key))).statusCode === 429);
    check((await request('POST','/messages',bearer(key))).statusCode === 429);
    check((await request('GET','/models',bearer(key))).statusCode === 200);
    quota(1);
    repo.update(user.id, {dailyLimit:3});
    check((await request('POST','/messages',bearer(key))).statusCode === 501);
    quota(2);
    check(calls === 1);
    throwForward = true;
    const failed = await request('POST','/chat/completions',bearer(key));
    check(failed.statusCode === 500);
    check(!JSON.stringify(responses).includes(key) && !JSON.stringify(responses).includes(wrong));
    check(!JSON.stringify(loggerEntries).includes(key) && !JSON.stringify(loggerEntries).includes(wrong));
    quota(3);
    await bounded(drain());
    drained = true;
    const stopped = await request('POST','/chat/completions',bearer(key));
    check(stopped.statusCode === 503);
    check(calls === 2);
    quota(3);
  } catch (error) {
    primary = true;
    if (error instanceof Error && (error.message === 'auth' || error.message === 'utc')) process.send?.(error.message);
  } finally {
    if (manager && !drained) {
      try { await bounded(drain()); drained = true; } catch { cleanup = true; }
    }
    if (!manager || drained) {
      try { db.close(); if (db.open) cleanup = true; } catch { cleanup = true; }
    }
    if (!manager || drained) globalThis.Date = RealDate;
  }
  return primary ? (cleanup ? 'primary-and-cleanup' : 'primary') : cleanup ? 'cleanup' : 'ok';
}

if (process.argv[2]) {
  process.send?.('ready');
  fixture().then(result => { process.send?.(result, () => process.disconnect()); }, () => {
    process.send?.('unexpected', () => process.disconnect());
  });
} else {
  async function run(mode) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], {stdio:['ignore','ignore','ignore','ipc'], env:{}});
      let ready = false, mutationApplied = false, category = '', result = '', timedOut = false, closed = false;
      const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
      const reapDeadline = setTimeout(() => {
        if (!closed) { child.unref(); if (child.connected) child.disconnect(); reject(new Error('fixture child closure unconfirmed')); }
      }, 10000);
      child.on('error', () => { result = 'child-error'; });
      child.on('message', message => {
        if (message === 'ready') ready = true;
        else if (message === 'mutation-applied') mutationApplied = true;
        else if (message === 'auth' || message === 'utc') category = message;
        else if (['ok','primary','cleanup','primary-and-cleanup','unexpected'].includes(message)) result = message;
      });
      child.on('close', (code, signal) => {
        closed = true; clearTimeout(deadline); clearTimeout(reapDeadline);
        if (!ready || timedOut || code !== 0 || signal || !result) reject(new Error('fixture child failed or timed out'));
        else resolve({result, category, mutationApplied});
      });
    });
  }
  test('v1 authentication and quota on isolated in-memory SQLite', {timeout: 35000}, async () => {
    for (const [mode, expected, category] of [['normal','ok',''], ['no-model-auth','primary','auth'], ['bad-day','primary','utc']]) {
      const actual = await run(mode);
      assert.equal(actual.result === expected && actual.category === category, true, 'fixture outcome mismatch');
      assert.equal(actual.mutationApplied, mode === 'no-model-auth', 'only the auth-bypass run must apply the mutation');
    }
  });
}
