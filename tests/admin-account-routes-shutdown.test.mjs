import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--fixture') {
  test('account collection routes own synchronous work during shutdown', async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture'], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let stage = 'startup', failed = false, timeout = false;
    child.on('message', value => { if (['normal', 'stop', 'reentrant', 'checkpoint-normal', 'checkpoint-mutant', 'checkpoint-checked', 'errors', 'complete'].includes(value)) stage = value; });
    child.on('error', () => { failed = true; });
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 20000);
    const result = await new Promise(resolve => {
      const deadline = setTimeout(() => resolve(null), 25000);
      child.once('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }); });
    });
    clearTimeout(timer);
    if (!result) { try { child.disconnect(); } catch {} child.unref(); }
    assert.ok(result, `owned fixture close unconfirmed: ${child.pid}, ${stage}`);
    assert.equal(timeout, false, `fixture timed out: ${stage}`);
    assert.equal(failed, false, `fixture spawn failed: ${stage}`);
    assert.equal(result.code, 0, `fixture failed: ${stage}`);
    assert.equal(result.signal, null, 'fixture terminated by signal');
    assert.equal(stage, 'complete', 'fixture did not complete');
  });
} else try {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const require = createRequire(import.meta.url);
  const password = 'fixture-password-marker', plaintext = 'fixture-plaintext-marker', ciphertext = 'fixture-ciphertext-marker', adminKey = 'synthetic-admin';
  const capturedConsole = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = (...args) => capturedConsole.push(args);
  const ts = require('typescript');
  const express = require('express');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const { inspect } = require('node:util');
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const strict = o => new Proxy(Object.freeze(o), { get(t, k) { if (!own(t, k)) throw Error('unexpected fake access'); return t[k]; } });
  function compile(path, deps, mutationControl = null) {
    let source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    if (mutationControl) {
      const needle = 'this.#context.run(root, () => dispatch(scope));';
      assert.equal(source.split(needle).length, 2, 'mutant seam missing or duplicated');
      source = source.replace(needle, 'mutationControl.terminal = scope.terminal;\n    ' + needle);
    }
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    if (path === 'request-work.ts') {
      assert.match(output, /class RequestWorkManager\s*\{\s*accepting = true;\s*active = 0;/, 'manager active must compile as an ordinary field');
    }
    const module = { exports: {} };
    const context = vm.createContext({ module, exports: module.exports, require(name) { if (!own(deps, name)) throw Error('unexpected dependency'); return deps[name]; }, process: strict({ env: strict({}) }), console, mutationControl, Date: FixedDate, Promise, Error, Number, Boolean, Object, Array, Symbol, WeakMap, Set, AbortController });
    new vm.Script(output, { filename: path }).runInContext(context);
    return module.exports;
  }
  const instant = '2020-01-01T12:00:00.000Z';
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return Date.parse(instant); } }
  const tomorrow = new Date(instant); tomorrow.setHours(24, 0, 0, 0);
  const routes = [{ method: 'GET', path: '/accounts', status: 200 }, { method: 'POST', path: '/accounts', body: { name: 'A', provider: 'openai', credentialType: 'api_key', credentials: plaintext, password }, status: 201 }];
  function fixture(mutant = false) {
    const events = [], logs = [], cryptoCalls = [], sql = [];
    const mutationControl = mutant ? {} : null;
    let onDb = () => {}, onCrypto = () => {}, decryptFailure = false, decryptThrown, uuidCalls = 0, keyCalls = 0;
    const touch = name => { events.push(name); onDb(); };
    const row = { id: 'a1', name: 'A', provider: 'openai', credential_type: 'api_key', credentials: ciphertext, meta: '{}', quota_info: null, status: 'active', last_used: null, last_error: null, daily_quota: 0, used_today: 0, quota_reset_at: '2020-01-01T00:00:00Z', priority: 0, weight: 1, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' };
    const db = strict({ prepare(query) { sql.push(['prepare', query]); touch('prepare'); return strict({ run(...args) { sql.push(['run', args]); touch('run'); return { changes: 1 }; }, get(...args) { sql.push(['get', args]); touch('get'); return row; }, all(...args) { sql.push(['all', args]); touch('all'); return [row]; } }); } });
    const accounts = compile('db/repositories/accounts.ts', { '../client.js': strict({ getDb() { touch('getDb'); return db; } }), crypto: strict({ randomUUID: () => { uuidCalls++; return 'a1'; }, createHash() { throw Error('unexpected hash'); } }), '../../upstream/oauth.js': strict({ parseStoredCredentials() { throw Error('unexpected parser'); } }), '../../utils/encryption.js': strict({ CredentialVault: class { encrypt(value) { cryptoCalls.push(['encrypt', value]); onCrypto('encrypt'); return ciphertext; } decrypt(value) { cryptoCalls.push(['decrypt', value]); onCrypto('decrypt'); if (decryptFailure) throw decryptThrown; return plaintext; } } }) });
    const work = compile('request-work.ts', { 'node:async_hooks': strict({ AsyncLocalStorage }) }, mutationControl);
    const logger = { info(...args) { logs.push(['info', ...args]); }, warn(...args) { logs.push(['warn', ...args]); }, debug(...args) { logs.push(['debug', ...args]); }, error(...args) { logs.push(['error', ...args]); } };
    class Empty {}
    const encryption = strict({ generateApiKey() { keyCalls++; }, hashApiKey() { keyCalls++; throw Error('unexpected hash'); } });
    const auth = compile('auth/user-auth.ts', { '../db/repositories/users.js': strict({ UserRepository: Empty }), '../utils/encryption.js': encryption, '../utils/logger.js': strict({ logger }), '../config/env.js': strict({ env: strict({ ADMIN_API_KEY: 'synthetic-admin' }) }), '../db/async-writer.js': strict({ withAsyncWriter() { throw Error('unexpected writer'); } }), '../request-work.js': work });
    const admin = compile('routes/admin.ts', { express, '../auth/user-auth.js': auth, '../request-work.js': work, '../db/repositories/accounts.js': accounts, '../db/repositories/users.js': strict({ UserRepository: Empty }), '../db/repositories/usage-logs.js': strict({ UsageLogRepository: Empty }), '../db/repositories/settings.js': strict({ SettingsRepository: Empty, STRATEGIES: [] }), '../utils/encryption.js': encryption, '../utils/logger.js': strict({ logger }), '../upstream/oauth.js': strict({ setOnLoginComplete() {} }), '../upstream/siwc-login.js': strict({ createSiwcRouter: () => (_req, _res, next) => next() }), './routing-snapshot.js': strict({}) });
    return { router: admin.default, work: work.requestWork, events, logs, logger, sql, cryptoCalls, row, mutationControl, counts: () => [uuidCalls, keyCalls], setOnDb(fn) { onDb = fn; }, setOnCrypto(fn) { onCrypto = fn; }, failDecrypt(...values) { decryptFailure = true; decryptThrown = values.length ? values[0] : Error([password,plaintext,ciphertext].join(' ')); } };
  }
  function dispatch(f, route, authorization = 'Bearer synthetic-admin', fault = {}) {
    const app = express(); app.use('/admin', f.router);
    const url = '/admin' + route.path;
    const req = Object.assign(Object.create(express.request), { app, method: route.method, url, originalUrl: url, headers: authorization ? { authorization } : {}, body: route.body || {} });
    const headers = Object.create(null), calls = { destroy: 0 };
    const res = Object.assign(Object.create(express.response), { req, app, statusCode: 200, locals: {}, finished: false, setHeader(k,v) { headers[k.toLowerCase()] = v; }, getHeader(k) { return headers[k.toLowerCase()]; }, end(v) { this.body = v; this.finished = true; return this; }, destroy() { calls.destroy++; if (fault.destroy) throw Error('synthetic-secret'); } });
    const status = res.status, json = res.json;
    res.status = function (n) { if (fault.status) throw Error('synthetic-secret'); return status.call(this,n); };
    res.json = function (v) { fault.onJson?.(); if (fault.json) throw Error('synthetic-secret'); return json.call(this,v); };
    if (fault.sent) Object.defineProperty(res, 'headersSent', { value: true });
    if (fault.headerThrows) Object.defineProperty(res, 'headersSent', { get() { throw Error('synthetic-secret'); } });
    if (fault.ended) Object.defineProperty(res, 'writableEnded', { get() { throw Error('synthetic-secret'); } });
    req.res = res;
    let escaped = false, forwarded = false;
    try { app.handle(req,res,() => { forwarded = true; }); } catch { escaped = true; }
    assert.equal(escaped, false, 'no exception may escape'); assert.equal(forwarded, false, 'no error may be forwarded');
    const serialized = JSON.stringify([res.body, f.logs, capturedConsole]) + inspect([f.logs, capturedConsole], { depth: 20, maxStringLength: null, maxArrayLength: null });
    for (const marker of [password, plaintext, ciphertext, adminKey]) assert.equal(serialized.includes(marker), false, 'sensitive marker leaked');
    if (fault.expectDestroy) return { status: res.statusCode, calls };
    assert.equal(res.writableEnded, true, 'must finish synchronously');
    return { status: res.statusCode, body: JSON.parse(res.body), calls };
  }
  process.send?.('normal');
  for (const route of routes) {
    for (const [auth, expected, body] of [[null,401,{error:{type:'authentication_error',message:'Missing admin API key.'}}], ['Bearer wrong',403,{error:{type:'permission_denied',message:'Invalid admin API key.'}}]]) { const f = fixture(); const result=dispatch(f,route,auth); assert.equal(result.status,expected); assert.deepEqual(result.body,body); assert.deepEqual(f.events,[]); assert.deepEqual(f.cryptoCalls,[]); assert.deepEqual(f.logs,auth ? [['warn','Invalid admin API key attempt']] : []); }
    const f = fixture(), result = dispatch(f,route);
    assert.equal(result.status,route.status);
    const base={id:'a1',name:'A',provider:'openai',credentialType:'api_key',status:'active',dailyQuota:0,usedToday:0,priority:0,weight:1,createdAt:'2020-01-01T00:00:00.000Z'};
    assert.deepEqual(result.body,route.method === 'GET' ? {accounts:[{...base,credentialStatus:'available',lastUsed:null,lastError:null,quotaResetAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z'}]} : {account:base});
    assert.equal(JSON.stringify([result.body,f.logs]).includes('synthetic-secret'),false);
    assert.equal(JSON.stringify([result.body,f.logs]).includes('synthetic-admin'),false);
    assert.deepEqual(f.events,route.method === 'GET' ? ['getDb','prepare','all'] : ['getDb','prepare','run','getDb','prepare','get']);
    assert.equal(JSON.stringify(f.cryptoCalls) === JSON.stringify(route.method === 'GET' ? [['decrypt',ciphertext]] : [['encrypt',plaintext],['decrypt',ciphertext]]), true, 'crypto calls mismatch');
    assert.equal(JSON.stringify(f.counts()) === JSON.stringify(route.method === 'GET' ? [0,0] : [1,0]), true, 'UUID or key count mismatch');
    assert.deepEqual(f.sql.map(x => x[0]),route.method === 'GET' ? ['prepare','all'] : ['prepare','run','prepare','get']);
    if (route.method === 'GET') { assert.equal(f.sql[0][1],'SELECT * FROM upstream_accounts ORDER BY provider, priority, name'); assert.deepEqual(f.sql[1][1],[]); assert.deepEqual(f.logs,[['debug','Admin authenticated']]); }
    else {
      const insert = `
      INSERT INTO upstream_accounts (
        id, name, provider, credential_type, credentials, meta, quota_info,
        status, last_used, last_error,
        daily_quota, used_today, quota_reset_at,
        priority, weight,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', NULL, NULL, ?, 0, ?, ?, ?, ?, ?)
    `;
      assert.equal(f.sql[0][1] === insert, true, 'insert statement mismatch');
      assert.equal(JSON.stringify(f.sql[1][1]) === JSON.stringify(['a1','A','openai','api_key',ciphertext,'{}',0,tomorrow.toISOString(),0,1,instant,instant]), true, 'insert arguments mismatch');
      assert.equal(f.sql[2][1] === 'SELECT * FROM upstream_accounts WHERE id = ?', true, 'select statement mismatch');
      assert.equal(JSON.stringify(f.sql[3][1]) === JSON.stringify(['a1']), true, 'select arguments mismatch');
      assert.deepEqual(JSON.parse(JSON.stringify(f.logs)),[['debug','Admin authenticated'],['info',{accountId:'a1',name:'A',provider:'openai'},'Account created']]);
    }
  }
  { const f=fixture(); f.row.last_error='synthetic-secret'; const result=dispatch(f,routes[0]); assert.equal(result.body.accounts[0].lastError,'Account error details redacted'); assert.equal(JSON.stringify([result.body,f.logs]).includes('synthetic-secret'),false); }
  { const f=fixture(); f.row.last_error=[password,plaintext,ciphertext].join(' '); f.failDecrypt(); const result=dispatch(f,routes[0]); assert.equal(result.status,200); assert.equal(result.body.accounts[0].credentialStatus,'unavailable'); assert.equal(result.body.accounts[0].lastError,'Credential unavailable; verify the encryption key or replace credentials'); assert.equal(JSON.stringify(f.cryptoCalls) === JSON.stringify([['decrypt',ciphertext]]), true, 'decrypt failure call mismatch'); }
  for (const route of routes) {
    const revoked=Proxy.revocable({},{}); revoked.revoke();
    for (const thrown of [Error([password,plaintext,ciphertext].join(' ')), null, undefined, false, 0, '', revoked.proxy]) {
      const f=fixture(); f.failDecrypt(thrown); f.row.last_error=[password,plaintext,ciphertext].join(' ');
      const result=dispatch(f,route);
      assert.equal(result.status,route.method === 'GET' ? 200 : 500, 'decrypt failure status mismatch');
      if (route.method === 'GET') { assert.equal(result.body.accounts[0].credentialStatus,'unavailable'); assert.equal(result.body.accounts[0].lastError,'Credential unavailable; verify the encryption key or replace credentials'); }
      else assert.equal(JSON.stringify(result.body) === JSON.stringify({error:{type:'internal_error',message:'Failed to process admin account request'}}), true, 'decrypt failure response mismatch');
      assert.equal(JSON.stringify(f.cryptoCalls) === JSON.stringify(route.method === 'GET' ? [['decrypt',ciphertext]] : [['encrypt',plaintext],['decrypt',ciphertext]]),true,'decrypt failure calls mismatch');
    }
  }
  for (const body of [{}, ...[{priority:-1},{priority:1.5},{priority:Number.MAX_SAFE_INTEGER+1},{weight:0},{weight:1.5},{weight:Number.MAX_SAFE_INTEGER+1}].map(x=>({...routes[1].body,...x}))]) { const f=fixture(); const result=dispatch(f,{...routes[1],body}); assert.equal(result.status,400); assert.deepEqual(result.body,{error:{type:'invalid_request',message:Object.keys(body).length ? 'Invalid priority or weight' : 'Missing required fields: name, provider, credentialType, credentials'}}); assert.deepEqual(f.events,[]); assert.deepEqual(f.cryptoCalls,[]); }
  for (const values of [{priority:0,weight:1},{priority:Number.MAX_SAFE_INTEGER,weight:Number.MAX_SAFE_INTEGER},{priority:101,weight:101}]) { const f=fixture(); assert.equal(dispatch(f,{...routes[1],body:{...routes[1].body,...values}}).status,201); assert.equal(f.sql[1][1][8],values.priority); assert.equal(f.sql[1][1][9],values.weight); }
  process.send?.('stop');
  for (const route of routes) { const f=fixture(); await f.work.stopAndDrain(); const result=dispatch(f,route); assert.equal(result.status,503); assert.deepEqual(result.body,{error:{type:'service_unavailable',message:'Server is shutting down.'}}); assert.deepEqual(f.events,[]); assert.deepEqual(f.cryptoCalls,[]); for (const fault of [{status:true},{json:true},{json:true,ended:true,destroy:true}]) { const denied=fixture(); await denied.work.stopAndDrain(); assert.equal(dispatch(denied,route,undefined,{...fault,expectDestroy:true}).calls.destroy,1); assert.deepEqual(denied.events,[]); assert.deepEqual(denied.cryptoCalls,[]); } }
  process.send?.('reentrant');
  for (const route of routes) {
    const baseline=fixture(); dispatch(baseline,route); const expected=[...baseline.events];
    for (let i=0;i<expected.length;i++) {
      const f=fixture(); let index=0, drain; const order=[];
      f.setOnDb(() => { if (index++ === i) { drain=f.work.stopAndDrain(); drain.then(() => order.push('drain')); queueMicrotask(() => order.push('marker')); } });
      assert.equal(dispatch(f,route).status,route.status); assert.deepEqual(f.events,expected); assert.ok(drain); await drain; assert.deepEqual(order,['marker','drain']);
    }
  }
  async function checkpoint(route, point, mutant) {
    const f=fixture(mutant); let drain, entered=0, beforeStop, afterStop, observed, mutantInstalled, afterRelease;
    const stop = () => {
      entered++;
      beforeStop = f.work.active;
      drain = f.work.stopAndDrain();
      afterStop = f.work.active;
      if (mutant) {
        mutantInstalled = typeof f.mutationControl.terminal === 'function';
        if (mutantInstalled) f.mutationControl.terminal();
        afterRelease = f.work.active;
      }
      // Read synchronously: promise reactions cannot run until this stack unwinds.
      observed = f.work.active;
    };
    f.setOnCrypto(name => { if (name === point) stop(); });
    // This is the fake response's json entry, not JSON serialization itself.
    const result=dispatch(f,route,undefined,{onJson: () => { if (point === 'json') stop(); }});
    assert.equal(result.status,route.status); assert.equal(entered,1,'checkpoint not reached exactly once'); assert.ok(drain,'drain missing');
    assert.equal(beforeStop,1,'expected one root before stop');
    assert.equal(afterStop,1,'stop must retain the root synchronously');
    if (mutant) { assert.equal(mutantInstalled,true,'mutant terminal not installed'); assert.equal(afterRelease,0,'mutant must release exactly one root after stop'); }
    assert.equal(f.work.active,0,'root must be released after dispatch returns');
    let timer;
    try { await Promise.race([drain, new Promise((_, reject) => { timer=setTimeout(() => reject(Error('drain timed out')),1000); })]); }
    finally { clearTimeout(timer); }
    if (observed !== 1) throw Error('ownership active count mismatch');
  }
  for (const [route, points] of [[routes[0],['decrypt','json']],[routes[1],['encrypt','decrypt','json']]]) for (const point of points) {
    process.send?.('checkpoint-normal');
    await checkpoint(route,point,false);
    let caught = false;
    process.send?.('checkpoint-mutant');
    try { await checkpoint(route,point,true); } catch (e) { caught = e?.message === 'ownership active count mismatch'; }
    process.send?.('checkpoint-checked');
    assert.equal(caught,true,'mutant must fail the same ownership assertion');
  }
  process.send?.('errors');
  for (const route of routes) {
    const revoked=Proxy.revocable({},{}); revoked.revoke();
    for (const thrown of [Error('synthetic-secret'),null,false,undefined,0,'',revoked.proxy]) {
      const f=fixture(); f.setOnDb(() => { throw thrown; });
      f.logger.error = (...args) => { f.logs.push(['error',...args]); throw Error('synthetic-secret'); };
      const result=dispatch(f,route); assert.equal(result.status,500); assert.deepEqual(result.body,{error:{type:'internal_error',message:'Failed to process admin account request'}}); assert.deepEqual(f.logs,[['debug','Admin authenticated'],['error','Failed to process admin account request']]);
    }
    for (const fault of [{json:true},{status:true},{sent:true},{headerThrows:true},{json:true,ended:true,destroy:true}]) { const f=fixture(); f.setOnDb(() => { throw null; }); const result=dispatch(f,route,undefined,{...fault,expectDestroy:true}); assert.equal(result.calls.destroy,1); assert.deepEqual(f.logs,[['debug','Admin authenticated'],['error','Failed to process admin account request']]); }
    { const f=fixture(); const result=dispatch(f,route,undefined,{json:true,expectDestroy:true}); assert.equal(result.calls.destroy,1); }
  }
  { const f=fixture(); let calls=0; f.logger.info=()=>{ calls++; throw Error('synthetic-secret'); }; const result=dispatch(f,routes[1]); assert.equal(calls,1); assert.equal(result.status,500); assert.deepEqual(result.body,{error:{type:'internal_error',message:'Failed to process admin account request'}}); assert.deepEqual(f.logs,[['debug','Admin authenticated'],['error','Failed to process admin account request']]); }
  process.send?.('complete');
} catch { process.exitCode = 1; }
