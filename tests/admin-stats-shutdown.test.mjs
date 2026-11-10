import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The child has no inherited environment and never opens a socket or database.
if (process.argv.includes('--fixture')) {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { EventEmitter } = await import('node:events');
  const vm = await import('node:vm');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  // Express is host-loaded only in this child, started with env: {}.
  const express = require('express');
  const root = new URL('../', import.meta.url);
  let consoleCalls = [];
  const fakeConsole = Object.freeze(Object.fromEntries(['log','info','warn','error','debug'].map(k => [k, (...args) => consoleCalls.push([k, ...args])])));
  const fakeProcess = Object.freeze({ env: Object.freeze(Object.create(null)) });
  function load(path, imports) {
    const source = readFileSync(new URL(path, root), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    const lookup = (name) => {
      if (!Object.hasOwn(imports, name)) throw new Error(`unexpected import ${name}`);
      return imports[name];
    };
    // A compartment for accidental-global isolation, not a security sandbox.
    const context = { require: lookup, module, exports: module.exports, process: fakeProcess, console: fakeConsole };
    vm.runInNewContext(js, context, { filename: path });
    return module.exports;
  }
  const crypto = require('node:crypto');
  const work = load('src/request-work.ts', { 'node:async_hooks': require('node:async_hooks') });
  let manager, ops, checkpoint, failure, injected, thrownValue;
  const db = {
    function(name) { ops.push('function:' + name); checkpoint(); },
    prepare(sql) {
      let kind = sql.includes('FROM users ORDER BY') ? 'users' : sql.includes('FROM upstream_accounts ORDER BY') ? 'accounts' : sql.includes('FROM usage_logs') ? 'usage' : 'unexpected';
      ops.push('prepare:' + kind); checkpoint();
      if (failure === kind) throw new Error('SYNTHETIC_SECRET');
      if (injected === kind) throw thrownValue;
      return {
        all() {
          ops.push('all:' + kind); checkpoint();
          if (kind === 'users') return [
            { enabled: 1, tier: 'free', created_at: 0, updated_at: 0 },
            { enabled: 0, tier: 'pro', created_at: 0, updated_at: 0 },
          ];
          if (kind === 'accounts') return [
            { provider: 'openai', status: 'active', credentials: 'fake', quota_reset_at: 0, created_at: 0, updated_at: 0 },
            { provider: 'anthropic', status: 'disabled', credentials: 'fake', quota_reset_at: 0, created_at: 0, updated_at: 0 },
          ];
          throw new Error('unexpected all');
        },
        get() { ops.push('get:' + kind); checkpoint(); assert.equal(kind, 'usage'); return { total: 3, successful: 2 }; },
      };
    },
  };
  const dbImport = { getDb: () => { ops.push('getDb'); checkpoint(); return db; } };
  // Deliberate decryption stub; SQL adapter above is synthetic, not SQLite.
  const encryption = { CredentialVault: class { decrypt() { ops.push('decrypt'); checkpoint(); return 'fake'; } }, hashApiKey() {}, generateApiKey() {} };
  const users = load('src/db/repositories/users.ts', { '../client.js': dbImport, crypto });
  const accounts = load('src/db/repositories/accounts.ts', { '../client.js': dbImport, crypto, '../../upstream/oauth.js': {}, '../../utils/encryption.js': encryption });
  const utc = load('src/db/usage-utc.ts', {});
  const usage = load('src/db/repositories/usage-logs.ts', { '../client.js': dbImport, crypto, '../usage-utc.js': utc });
  let logs = [];
  const logger = { info() {}, warn() {}, debug() {}, error(...args) { logs.push(args); } };
  const env = { ADMIN_API_KEY: 'synthetic-admin' };
  // Each case gets a fresh real manager and production router.
  function setup() {
    manager = new work.RequestWorkManager(); ops = []; logs = []; consoleCalls = []; failure = undefined; injected = undefined; thrownValue = undefined; checkpoint = () => {};
    const auth = load('src/auth/user-auth.ts', { '../db/repositories/users.js': users, '../utils/encryption.js': encryption, '../utils/logger.js': { logger }, '../config/env.js': { env }, '../db/async-writer.js': {}, '../request-work.js': { requestWork: manager } });
    const admin = load('src/routes/admin.ts', {
      express, '../auth/user-auth.js': auth, '../request-work.js': { requestWork: manager },
      '../db/repositories/users.js': users, '../db/repositories/accounts.js': accounts, '../db/repositories/usage-logs.js': usage,
      '../utils/encryption.js': encryption, '../utils/logger.js': { logger },
      '../upstream/oauth.js': { setOnLoginComplete() {} },
      '../db/repositories/settings.js': { SettingsRepository: class {}, STRATEGIES: [] },
      '../upstream/siwc-login.js': { createSiwcRouter: () => express.Router() },
      './routing-snapshot.js': { routingSnapshot() {} },
    });
    return admin.default;
  }
  function dispatch(router, authorization, hooks = {}) {
    const req = new EventEmitter(); Object.assign(req, { method: 'GET', url: '/stats', originalUrl: '/stats', headers: authorization ? { authorization } : {} });
    const res = new EventEmitter();
    Object.assign(res, { code: 200, headersSent: false, writableEnded: false, destroyed: false, headers: {},
      set(k,v) { this.headers[k.toLowerCase()] = v; return this; },
      status(n) { hooks.status?.(); this.code=n; return this; },
      json(v) { hooks.json?.(); this.body=v; this.headersSent=true; this.writableEnded=true; return this; },
      destroy() { hooks.destroy?.(); this.destroyed=true; },
    });
    let next = 0; router.handle(req, res, () => { next++; });
    return { res, next };
  }
  const expected = { todayUsage: { totalRequests: 3, successRequests: 2 }, users: { total: 2, enabled: 1, free: 1, pro: 1 }, accounts: { total: 2, byProvider: { anthropic: 1, openai: 1, google: 0 }, byStatus: { active: 1, quota_exceeded: 0, error: 0, disabled: 1 } } };
  const expectedOps = ['getDb','prepare:users','all:users','getDb','prepare:accounts','all:accounts','decrypt','decrypt','getDb','function:usage_utc_ms','prepare:usage','get:usage'];
  const key = 'Bearer synthetic-admin';
  let router = setup(); let result = dispatch(router, key);
  assert.equal(result.res.code, 200); assert.deepEqual(JSON.parse(JSON.stringify(result.res.body)), expected); assert.deepEqual(ops, expectedOps); assert.equal(result.res.headers['cache-control'], 'no-store'); assert.equal(result.next, 0); assert.equal(manager.active, 0);
  for (const [keyValue, code] of [[undefined, 401], ['Bearer wrong', 403]]) { router=setup(); result=dispatch(router,keyValue); assert.equal(result.res.code,code); assert.deepEqual(ops,[]); assert.equal(result.next,0); }
  router=setup(); await manager.stopAndDrain(); result=dispatch(router,key); assert.equal(result.res.code,503); assert.deepEqual(ops,[]); assert.equal(result.next,0);
  // Stop synchronously at each individual repository/response boundary. The
  // root must remain live until the real response call returns.
  async function checkpointCase(target, premature = false) {
    router=setup(); let n=0, drain, active, captured;
    const original = manager.ownedDispatch;
    manager.ownedDispatch = function(fn) { return original.call(this, scope => { captured=scope; fn(scope); }); };
    const inspect = () => { if (n++ === target) { drain=manager.stopAndDrain(); if (premature) captured.terminal(); active=manager.active; } };
    try {
      checkpoint=inspect; result=dispatch(router,key,{json:inspect});
      assert.equal(n,expectedOps.length+1); assert.deepEqual(ops,expectedOps); assert.ok(drain); assert.equal(result.next,0);
      assert.equal(active,1,'active root at stopped checkpoint');
      assert.equal(manager.active,0);
    } finally {
      checkpoint=()=>{}; manager.ownedDispatch=original; captured?.terminal();
      drain ||= manager.stopAndDrain();
      let timer; try { await Promise.race([drain,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('drain timeout')),500);})]); } finally { clearTimeout(timer); }
    }
  }
  for (let target=0; target<expectedOps.length+1; target++) await checkpointCase(target);
  for (let target=0; target<expectedOps.length+1; target++) await assert.rejects(checkpointCase(target,true), error => error instanceof assert.AssertionError && error.message.startsWith('active root at stopped checkpoint') && error.actual === 0 && error.expected === 1);
  for (const kind of ['users','accounts','usage']) { router=setup(); failure=kind; result=dispatch(router,key); assert.equal(result.res.code,500); assert.deepEqual(JSON.parse(JSON.stringify(result.res.body)),{error:{type:'internal_error',message:'Failed to process admin stats request'}}); assert.deepEqual(logs,[['Failed to process admin stats request']]); assert.equal(result.next,0); assert.equal(manager.active,0); }
  const revoked = Proxy.revocable({},{}); revoked.revoke();
  for (const thrown of [undefined, null, false, 0, '', revoked.proxy]) {
    router=setup(); injected='users'; thrownValue=thrown; result=dispatch(router,key);
    assert.deepEqual(ops,['getDb','prepare:users']);
    assert.equal(result.res.code,500); assert.deepEqual(JSON.parse(JSON.stringify(result.res.body)),{error:{type:'internal_error',message:'Failed to process admin stats request'}});
    assert.deepEqual(logs,[['Failed to process admin stats request']]); assert.deepEqual(consoleCalls,[]); assert.equal(result.next,0); assert.equal(manager.active,0);
    let destroys=0;
    router=setup(); result=dispatch(router,key,{json(){throw thrown;},destroy(){destroys++; throw thrown;}}); assert.equal(destroys,1); assert.equal(result.next,0); assert.equal(manager.active,0);
    destroys=0; router=setup(); failure='users'; result=dispatch(router,key,{status(){throw thrown;},destroy(){destroys++; throw thrown;}}); assert.equal(destroys,1); assert.equal(result.next,0); assert.equal(manager.active,0);
  }
  process.stdout.write('fixture ok\n');
} else {
  test('admin stats owns synchronous reads through response and shutdown', { timeout: 10000 }, async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture'], { env: {}, stdio: ['ignore','pipe','pipe'] });
    let stdout='', stderr='', closed=false, spawnError=false, overflow=false;
    const collect = (which, b) => {
      if (which === 'stdout') stdout += b; else stderr += b;
      if (stdout.length + stderr.length > 16384) { overflow=true; child.kill(); stdout=stdout.slice(0,8192); stderr=stderr.slice(0,8192); }
    };
    child.stdout.on('data', b => collect('stdout', b)); child.stderr.on('data', b => collect('stderr', b));
    child.on('error',()=>{spawnError=true;});
    const close = new Promise(resolve=>child.once('close',(c,s)=>{closed=true; resolve([c,s]);}));
    let killTimer, closeTimer;
    try {
      killTimer=setTimeout(()=>child.kill(),5000);
      const [code, signal] = await Promise.race([close, new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('fixture child close unconfirmed')),7000);})]);
      assert.equal(spawnError,false,'fixture child error'); assert.equal(overflow,false,'fixture output exceeded limit');
      assert.equal(signal,null); assert.equal(code,0,'fixture child failed'); assert.ok(stderr === '', 'fixture wrote stderr'); assert.ok(stdout === 'fixture ok\n', 'unexpected fixture output');
    } finally { if (!closed) child.kill(); clearTimeout(killTimer); clearTimeout(closeTimer); }
  });
}
