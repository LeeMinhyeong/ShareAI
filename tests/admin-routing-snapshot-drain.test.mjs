import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--isolated') {
  test('routing snapshot owns its synchronous shutdown boundary', async () => {
    const markers = ['synthetic-plaintext-marker','synthetic-cipher-marker','synthetic-password-marker','synthetic-user-token-marker','synthetic-secret-fault-marker'];
    const result = await new Promise(resolve => {
      let child, timer, deadline, closed = false, error = false, overflow = false;
      let stdout = '', stderr = '';
      const finish = (status, signal) => {
        clearTimeout(timer); clearTimeout(deadline);
        resolve({closed, error, overflow, status, signal, stdout, stderr});
      };
      try {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], {env:{}, stdio:['ignore','pipe','pipe']});
        for (const [stream, name] of [[child.stdout,'stdout'],[child.stderr,'stderr']]) {
          stream.setEncoding('utf8');
          stream.on('error', () => { error = true; });
          stream.on('data', chunk => {
            if (name === 'stdout') stdout += chunk; else stderr += chunk;
            if (stdout.length + stderr.length > 200000 && !overflow) { overflow = true; child.kill(); }
          });
        }
        child.on('error', () => { error = true; });
        child.on('close', (status, signal) => { closed = true; finish(status, signal); });
        timer = setTimeout(() => { error = true; child.kill(); }, 15000);
        deadline = setTimeout(() => {
          error = true; child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null, null);
        }, 18000);
      } catch { error = true; finish(null, null); }
    });
    assert.equal(markers.every(s => !(result.stdout + result.stderr).includes(s)), true, 'unsafe child output');
    assert.equal(result.closed && !result.error && !result.overflow && result.signal === null && result.status === 0, true, 'isolated child did not close successfully');
  });
} else {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const express = require('express');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const root = new URL('../', import.meta.url);
  const logs = [];
  const silence = Object.fromEntries(['log','info','warn','error','debug'].map(k => [k, (...args) => logs.push(args)]));
  const strict = values => new Proxy(Object.assign(Object.create(null), values), {
    get(target, key) { if (!Object.hasOwn(target, key)) throw new Error('Unexpected process property'); return target[key]; },
  });
  function load(file, dependencies, globals = {}) {
    const source = readFileSync(new URL(file, root), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    const context = vm.createContext({ ...globals, exports, module: { exports }, console: silence, process: strict({ env: strict({}) }), require(id) {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected import: ${id}`);
      return dependencies[id];
    }});
    new vm.Script(js, { filename: file }).runInContext(context);
    return context.module.exports;
  }
  const workModule = load('src/request-work.ts', { 'node:async_hooks': { AsyncLocalStorage } });
  const manager = workModule.requestWork;
  let checkpoint = () => {};
  let getDbCalls = 0;
  let dbThrows = false;
  let dbFault = Object.create(null);
  // ADR 0008: the snapshot reads shared restrictions from the 429 v2 store inside one read transaction.
  let v2Invalid = false;
  const db = { transaction(fn) { return (...args) => fn(...args); }, prepare(sql) { const kind = sql.includes('sqlite_master') ? 'schema' : sql.includes('daily_reservations') ? 'quota' : sql.includes('ordinary_account_attempts') ? 'attempt' : sql.includes('account_429_v2_restrictions') ? 'restriction' : 'unexpected-query'; checkpoint(`prepare:${kind}`); return { get() { checkpoint(`get:${kind}`); return undefined; }, all() { checkpoint(`all:${kind}`); return []; } }; } };
  class Accounts { findAllAdmin() { checkpoint('findAllAdmin'); return [{ id: 'synthetic', provider: 'anthropic', status: 'active', dailyQuota: 0, stateRevision: 1 }]; } findActiveByProvider() { checkpoint('findActiveByProvider'); return [{ id: 'synthetic', status: 'active' }]; } }
  const fakeClient = { getDb() { getDbCalls++; checkpoint('getDb'); if (dbThrows) throw dbFault; return db; } };
  const oauth = { setOnLoginComplete() {} };
  let siwcFixture;
  const encryption = { CredentialVault: class { constructor() { checkpoint('siwc:vault'); } } };
  // Exercise the production validator with strictly synthetic dependencies.
  const { SiwcStore: RealSiwcStore } = load('src/upstream/siwc-store.ts', {
    'better-sqlite3': class { constructor() { throw new Error('Unexpected database construction'); } },
    'node:crypto': { createHash() { throw new Error('Unexpected hash'); }, randomUUID() { throw new Error('Unexpected UUID'); } },
  });
  class SyntheticSiwcStore {
    constructor(database, vault, options) { checkpoint('siwc:store'); if (database !== db || options.initialize !== false) throw new Error('Unexpected store arguments'); }
    readSnapshot(id) {
      checkpoint('siwc:read'); if (siwcFixture.throwRead) throw siwcFixture.fault;
      const value = siwcFixture.snapshots[id];
      const store = new RealSiwcStore({ prepare(sql) {
        if (sql !== 'SELECT credentials, revision FROM siwc_credentials WHERE id = ?') throw new Error('Unexpected store query');
        return { get(key) { if (key !== id) throw new Error('Unexpected store key'); return value == null ? undefined : { credentials:JSON.stringify(value.credential), revision:value.revision }; } };
      } }, { decrypt(value) { return value; } }, { initialize:false });
      return store.readSnapshot(id);
    }
  }
  const fixedNow = Date.parse('2030-01-01T00:00:00.000Z');
  class SnapshotDate extends Date { static now() { return fixedNow; } }
  const snapshot = load('src/routes/routing-snapshot.ts', {
    '../db/client.js': fakeClient, '../db/repositories/accounts.js': { AccountRepository: Accounts },
    '../account-pool/manager.js': { accountPool: { observedCooldown() { checkpoint('cooldown'); return 0; }, siwcFailureMarker() { checkpoint('siwc:pool'); return siwcFixture.local; } } },
    '../utils/encryption.js': encryption, '../upstream/siwc-store.js': { SiwcStore: SyntheticSiwcStore }, '../upstream/oauth.js': oauth,
    '../db/account-429-v2-store.js': { assert429V2Schema() { checkpoint('v2:assert'); if (v2Invalid || siwcFixture?.v2Invalid) throw new Error('Unsafe 429 v2 schema'); return 0n; } },
  }, { Date: SnapshotDate });
  const adminAuth = load('src/auth/user-auth.ts', {
    '../db/repositories/users.js': { UserRepository: class {} },
    '../utils/encryption.js': { hashApiKey() { throw new Error('Unexpected user authentication'); } },
    '../utils/logger.js': { logger: silence }, '../config/env.js': { env: strict({ ADMIN_API_KEY: 'synthetic-admin-key' }) },
    '../db/async-writer.js': { withAsyncWriter() { throw new Error('Unexpected writer'); } }, '../request-work.js': workModule,
  });
  let auth = 200;
  const admin = load('src/routes/admin.ts', {
    express, '../auth/user-auth.js': adminAuth,
    '../request-work.js': workModule, '../db/repositories/users.js': { UserRepository: class {} },
    '../db/repositories/accounts.js': { AccountRepository: Accounts }, '../db/repositories/usage-logs.js': { UsageLogRepository: class {} },
    '../utils/encryption.js': encryption, '../utils/logger.js': { logger: silence }, '../upstream/oauth.js': oauth,
    '../db/repositories/settings.js': { SettingsRepository: class {}, STRATEGIES: [] },
    '../upstream/siwc-login.js': { createSiwcRouter: () => express.Router() }, '../routes/routing-snapshot.js': snapshot,
    './routing-snapshot.js': snapshot,
  });
  const app = express();
  app.use('/admin', admin.default);
  function dispatch(options = {}) {
    const req = { method:'GET', url:'/admin/routing-snapshot', headers: {} };
    const res = { headers: {}, code: 200, headersSent: false, writableEnded: false, destroyed: false, attempts: 0, statusCalls:0, destroyCalls:0,
      setHeader(k,v) { this.headers[k] = v; },
      set(k,v) { this.headers[k] = v; return this; },
      status(code) { this.statusCalls++; this.code = code; if (options.throwStatus) throw options.fault; return this; },
      json(body) { this.attempts++; if (options.onJson) options.onJson(this); if (options.throwJson) { if (options.started) this.headersSent = true; throw Object.hasOwn(options,'jsonFault') ? options.jsonFault : options.fault; } this.body = JSON.parse(JSON.stringify(body)); this.headersSent = this.writableEnded = true; return this; },
      destroy() { this.destroyCalls++; this.destroyed = true; if (options.throwDestroy) throw options.fault; },
    };
    res.authHeaderObservations = [];
    Object.defineProperty(req.headers, 'authorization', { get() {
      res.authHeaderObservations.push(res.headers['Cache-Control']);
      return auth === 401 ? undefined : auth === 403 ? 'Bearer invalid-synthetic' : 'Bearer synthetic-admin-key';
    } });
    if (options.throwGetter) Object.defineProperty(res, options.throwGetter, { get() { throw null; } });
    let forwarded = 0;
    app.handle(req, res, () => { forwarded++; });
    assert.equal(forwarded, 0, 'unexpected Express continuation');
    return res;
  }
  for (const code of [401,403]) {
    auth = code; const before = getDbCalls; let preAuthHeader = false;
    const r = dispatch({ onJson(res) { preAuthHeader = res.headers['Cache-Control'] === 'no-store'; } });
    assert.equal(r.code,code); assert.equal(preAuthHeader,true); assert.deepEqual(r.authHeaderObservations,['no-store']); assert.equal(getDbCalls,before);
    assert.equal(r.body.error.type,code === 401 ? 'authentication_error' : 'permission_denied');
    assert.equal(r.body.error.message,code === 401 ? 'Missing admin API key.' : 'Invalid admin API key.');
  }
  auth = 200;
  const normal = dispatch();
  assert.equal(normal.code,200); assert.equal(normal.headers['Cache-Control'],'no-store'); assert.deepEqual(normal.authHeaderObservations,['no-store']);
  assert.deepEqual(normal.body.accounts,[{kind:'upstream',id:'synthetic',state:'no_known_block'}]); assert.equal(manager.active,0);
  dbThrows = true; const failed = dispatch(); dbThrows = false;
  assert.equal(failed.code,503); assert.equal(failed.headers['Cache-Control'],'no-store'); assert.deepEqual(failed.body,{ error:{ type:'service_unavailable', message:'Routing snapshot unavailable' } });
  // Each fresh manager is loaded separately; a stop is irreversible.
  for (const stage of ['getDb','findAllAdmin','findActiveByProvider','prepare:schema','get:schema','v2:assert','prepare:restriction','all:restriction','prepare:quota','get:quota','cooldown','prepare:attempt','get:attempt','response']) {
    const m = new workModule.RequestWorkManager();
    workModule.requestWork.ownedDispatch = m.ownedDispatch.bind(m);
    let observed = false, activeAtStop;
    checkpoint = name => { if (name === stage && !observed) { observed = true; void m.stopAndDrain(); activeAtStop = m.active; } };
    const r = dispatch({ onJson() { checkpoint('response'); } });
    assert.equal(observed,true,stage); assert.equal(activeAtStop,1,`root missing at ${stage}`); assert.equal(r.code,200); assert.equal(m.active,0);
    const before = getDbCalls; const denied = dispatch(); assert.equal(denied.code,503); assert.equal(denied.headers['Cache-Control'],'no-store');
    assert.deepEqual(denied.body,{error:{type:'service_unavailable',message:'Server is shutting down.'}}); assert.equal(getDbCalls,before);
  }
  checkpoint = () => {};
  // Apply the same root assertion after deliberately terminating the actual scope.
  for (const stage of ['getDb','findAllAdmin','findActiveByProvider','prepare:schema','get:schema','v2:assert','prepare:restriction','all:restriction','prepare:quota','get:quota','cooldown','prepare:attempt','get:attempt','response']) {
    const m = new workModule.RequestWorkManager(); let release, observed = false, activeAtStop;
    workModule.requestWork.ownedDispatch = callback => m.ownedDispatch(scope => { release = scope.terminal; callback(scope); });
    checkpoint = name => { if (name === stage && !observed) { observed = true; void m.stopAndDrain(); release(); activeAtStop = m.active; } };
    dispatch({ onJson() { checkpoint('response'); } });
    assert.equal(observed,true,stage);
    assert.throws(() => assert.equal(activeAtStop,1,`root missing at ${stage}`), { code:'ERR_ASSERTION', actual:0, expected:1 });
    assert.equal(m.active,0);
  }
  checkpoint = () => {};
  for (const options of [{ throwJson:true }, { throwJson:true, started:true }, { throwStatus:true }, { throwJson:true, throwDestroy:true }, { throwGetter:'headersSent' }, { throwGetter:'writableEnded' }, { throwGetter:'destroyed' }]) {
    const m = new workModule.RequestWorkManager(); workModule.requestWork.ownedDispatch = m.ownedDispatch.bind(m);
    dbThrows = !!(options.throwStatus || options.throwGetter);
    const r = dispatch(options); dbThrows = false;
    assert.ok(r.attempts <= 1); assert.equal(m.active,0);
  }

  // Inject at the real snapshot dependency and each response boundary independently.
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const secretMarker = 'synthetic-secret-fault-marker';
  for (const fault of [undefined, null, false, 0, revoked.proxy, new Error(secretMarker)]) {
    for (const stage of ['dependency','status','json','destroy']) {
      const m = new workModule.RequestWorkManager(); workModule.requestWork.ownedDispatch = m.ownedDispatch.bind(m);
      const seen = []; checkpoint = name => seen.push(name);
      const before = getDbCalls, logStart = logs.length;
      dbThrows = stage === 'dependency' || stage === 'status'; dbFault = stage === 'dependency' ? fault : null;
      const r = dispatch({ fault, jsonFault: stage === 'destroy' ? null : fault, throwStatus:stage === 'status', throwJson:stage === 'json' || stage === 'destroy', throwDestroy:stage === 'destroy' });
      dbThrows = false;
      assert.equal(getDbCalls-before,1,'snapshot dependency count');
      assert.equal(seen[0],'getDb');
      if (stage === 'dependency' || stage === 'status') assert.deepEqual(seen,['getDb']);
      else assert.deepEqual(seen,['getDb','findAllAdmin','findActiveByProvider','prepare:schema','get:schema','v2:assert','prepare:restriction','all:restriction','prepare:quota','get:quota','cooldown','prepare:attempt','get:attempt']);
      assert.equal(r.statusCalls,stage === 'dependency' || stage === 'status' ? 1 : 0);
      assert.equal(r.attempts,stage === 'status' ? 0 : 1);
      assert.equal(r.destroyCalls,stage === 'dependency' ? 0 : stage === 'destroy' ? 2 : 1);
      assert.equal(r.headers['Cache-Control'],'no-store');
      if (stage === 'dependency') assert.deepEqual(r.body,{error:{type:'service_unavailable',message:'Routing snapshot unavailable'}});
      else assert.equal(r.body,undefined);
      assert.equal(m.active,0);
      assert.equal(logs.slice(logStart).every(args => args.every(value => typeof value === 'string' && !value.includes(secretMarker))),true,'unsafe log');
    }
  }
  checkpoint = () => {};

  // Synthetic SQLite and store only: these do not execute production SQL or decrypt.
  const originalPrepare = db.prepare;
  const secrets = ['synthetic-plaintext-marker','synthetic-cipher-marker','synthetic-password-marker','synthetic-user-token-marker'];
  Accounts.prototype.hasRefreshIntent = function() { checkpoint('siwc:refresh-intent'); return siwcFixture.intent; };
  db.prepare = function(sql) {
    if (sql.includes('sqlite_master')) { checkpoint('siwc:prepare-schema'); return { get() { checkpoint('siwc:get-schema'); return siwcFixture.table ? { present:1 } : undefined; } }; }
    if (sql.includes('FROM siwc_accounts a')) { checkpoint('siwc:prepare-rows'); return { all() { checkpoint('siwc:all-rows'); return siwcFixture.rows; } }; }
    if (sql.includes('siwc_account_attempts')) { checkpoint('siwc:prepare-attempt'); return { get() { checkpoint('siwc:get-attempt'); return siwcFixture.open ? { present:1 } : undefined; } }; }
    if (sql.includes('account_429_v2_restrictions')) { siwcFixture.restrictionPrepares++; checkpoint('siwc:prepare-restrictions'); return { all() { checkpoint('siwc:all-restrictions'); return siwcFixture.restricted ? [{kind:'siwc',account_id:'siwc-synthetic'}] : []; } }; }
    return originalPrepare.call(this,sql);
  };
  function fixture() {
    return { restrictionPrepares:0, restricted:false, v2Invalid:false, table:true, rows:[{id:'siwc-synthetic',enabled:1}], snapshots:{'siwc-synthetic':{ revision:'synthetic-revision-7', credential:{ issuer:'https://auth.openai.com', subject:'synthetic-subject', clientId:'synthetic-client-id', accessToken:secrets[0], idToken:secrets[1], tokenType:'Bearer', savedAt:'2029-12-31T23:30:00Z', expiresIn:3600, scopes:['chatgpt.tokens.use.direct'], refreshToken:secrets[3], password:secrets[2] } }}, local:undefined, intent:false, open:false };
  }
  function assertStoreAcceptsFixture() {
    let accepted = false;
    try {
      const result = new SyntheticSiwcStore(db, null, { initialize:false }).readSnapshot('siwc-synthetic');
      accepted = result?.revision === 'synthetic-revision-7';
    } catch { /* Do not print credential-bearing exceptions. */ }
    assert.equal(accepted,true,'production store rejected synthetic credential');
  }
  function verifySnapshot(expected) {
    const start = logs.length, r = dispatch();
    const output = JSON.stringify(r.body) + JSON.stringify(logs.slice(start));
    assert.equal(secrets.every(s => !output.includes(s)),true,'unsafe snapshot output');
    assert.equal(r.code,200); assert.equal(r.headers['Cache-Control'],'no-store');
    assert.equal(JSON.stringify(r.body.accounts.filter(a => a.kind === 'siwc')) === JSON.stringify(expected),true,'SIWC readiness mismatch');
    assert.equal(manager.active,0);
  }
  workModule.requestWork.ownedDispatch = manager.ownedDispatch.bind(manager);
  siwcFixture = fixture(); siwcFixture.table = false; verifySnapshot([]);
  siwcFixture = fixture(); siwcFixture.rows = []; verifySnapshot([]);
  const row = state => [{kind:'siwc',id:'siwc-synthetic',state}];
  siwcFixture = fixture(); verifySnapshot(row('no_known_block'));
  // Matched fixtures isolate each condition; the API reports state, not reason/eligible fields.
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'].credential.scopes = ['offline_access']; assertStoreAcceptsFixture(); verifySnapshot(row('unavailable'));
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'].credential.scopes = ['offline_access','chatgpt.tokens.use.direct']; assertStoreAcceptsFixture(); verifySnapshot(row('no_known_block'));
  for (const [offset, expected, intentCalls] of [[1,'unavailable',0],[0,'no_known_block',1]]) {
    siwcFixture = fixture();
    const c = siwcFixture.snapshots['siwc-synthetic'].credential;
    c.savedAt = '2029-01-01T00:00:00Z'; c.scopes.push('offline_access'); c.earliestRefreshAt = fixedNow / 1000 + offset;
    assertStoreAcceptsFixture();
    let calls = 0; checkpoint = name => { if (name === 'siwc:refresh-intent') calls++; };
    verifySnapshot(row(expected)); checkpoint = () => {};
    assert.equal(calls,intentCalls,'refresh intent branch mismatch');
  }
  siwcFixture = fixture(); siwcFixture.rows[0].enabled = 0; verifySnapshot(row('unavailable'));
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'].credential.savedAt = '2000-01-01T00:00:00Z'; delete siwcFixture.snapshots['siwc-synthetic'].credential.refreshToken; verifySnapshot(row('unavailable'));
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'].credential.savedAt = 'invalid'; verifySnapshot(row('unknown'));
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'].credential.scopes = null; verifySnapshot(row('unknown'));
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'] = null; verifySnapshot(row('unavailable'));
  siwcFixture = fixture(); siwcFixture.v2Invalid = true; verifySnapshot(row('unknown')); // invalid v2 store: unknown, never unrestricted
  siwcFixture = fixture(); siwcFixture.open = true; verifySnapshot(row('open'));
  siwcFixture = fixture(); siwcFixture.local = {revision:'synthetic-revision-7',cooldownUntil:8640000000000000}; verifySnapshot([{kind:'siwc',id:'siwc-synthetic',state:'cooldown_until',cooldown_until:8640000000000000}]);
  siwcFixture = fixture(); siwcFixture.restricted = true; verifySnapshot(row('restricted')); // a v2 restriction is shown as presence, no wall-clock release
  siwcFixture = fixture(); siwcFixture.local = {revision:'synthetic-revision-8',cooldownUntil:8640000000000000}; verifySnapshot(row('no_known_block'));
  siwcFixture = fixture(); siwcFixture.snapshots['siwc-synthetic'].credential.savedAt = '2000-01-01T00:00:00Z'; siwcFixture.snapshots['siwc-synthetic'].credential.scopes.push('offline_access'); siwcFixture.intent = true; verifySnapshot(row('unavailable'));
  const revokedSiwc = Proxy.revocable({},{}); revokedSiwc.revoke();
  for (const fault of [undefined,null,false,0,revokedSiwc.proxy,new Error(secrets[0])]) {
    siwcFixture = fixture(); siwcFixture.throwRead = true; siwcFixture.fault = fault; verifySnapshot(row('unknown'));
    for (const stage of ['siwc:get-schema','siwc:all-rows','siwc:pool','siwc:get-attempt','siwc:all-restrictions']) {
      siwcFixture = fixture(); let hits = 0; const start = logs.length;
      checkpoint = name => { if (name === stage) { hits++; throw fault; } };
      const r = dispatch(); checkpoint = () => {};
      assert.equal(secrets.every(s => !(JSON.stringify(r.body)+JSON.stringify(logs.slice(start))).includes(s)),true,'unsafe fault output');
      assert.equal(hits,1,'fault stage not reached'); assert.equal(r.headers['Cache-Control'],'no-store');
      // A failed v2 restriction read fails closed as 'unknown' (routing-snapshot.ts), like a pool failure.
      if (stage === 'siwc:pool' || stage === 'siwc:all-restrictions') { assert.equal(r.code,200); assert.equal(JSON.stringify(r.body.accounts.filter(a => a.kind === 'siwc')) === JSON.stringify(row('unknown')),true,'pool failure state'); }
      else { assert.equal(r.code,503); assert.deepEqual(r.body,{error:{type:'service_unavailable',message:'Routing snapshot unavailable'}}); }
      assert.equal(manager.active,0);
    }
  }
  // The expired credential must reach the real refresh-intent branch.
  const stages = ['siwc:prepare-schema','siwc:get-schema','siwc:prepare-rows','siwc:all-rows','siwc:vault','siwc:store','siwc:prepare-restrictions','siwc:all-restrictions','siwc:read','siwc:pool','siwc:refresh-intent','siwc:prepare-attempt','siwc:get-attempt'];
  for (const mutant of [false,true]) for (const stage of stages) {
    siwcFixture = fixture();
    const c = siwcFixture.snapshots['siwc-synthetic'].credential;
    c.savedAt = '2000-01-01T00:00:00Z'; c.scopes.push('offline_access');
    const m = new workModule.RequestWorkManager(); let release, observed = 0, activeAtStop; const hits = [];
    workModule.requestWork.ownedDispatch = callback => m.ownedDispatch(scope => { release = scope.terminal; callback(scope); });
    checkpoint = name => { if (name.startsWith('siwc:')) hits.push(name); if (name === stage && !observed) { observed++; void m.stopAndDrain(); if (mutant) release(); activeAtStop = m.active; } };
    const before = getDbCalls, logStart = logs.length, r = dispatch();
    assert.equal(secrets.every(s => !(JSON.stringify(r.body)+JSON.stringify(logs.slice(logStart))).includes(s)),true,'unsafe SIWC output');
    assert.deepEqual(hits,stages,'synthetic stage sequence'); assert.equal(siwcFixture.restrictionPrepares,1,'one v2 restriction read per snapshot');
    assert.equal(observed,1,stage); assert.equal(getDbCalls-before,1); assert.equal(r.code,200); assert.equal(r.headers['Cache-Control'],'no-store');
    assert.equal(JSON.stringify(r.body.accounts.filter(a => a.kind === 'siwc')) === JSON.stringify(row('no_known_block')),true,'SIWC result mismatch');
    if (mutant) assert.throws(() => assert.equal(activeAtStop,1,'root missing'), {code:'ERR_ASSERTION',actual:0,expected:1});
    else assert.equal(activeAtStop,1,'root missing');
    assert.equal(m.active,0);
    const count = getDbCalls, denied = dispatch();
    assert.equal(denied.code,503); assert.equal(denied.headers['Cache-Control'],'no-store');
    assert.deepEqual(denied.body,{error:{type:'service_unavailable',message:'Server is shutting down.'}}); assert.equal(getDbCalls,count);
  }
  checkpoint = () => {}; db.prepare = originalPrepare;

  // Real client source with only fake filesystem and fake SQLite: shutdown reentry in constructor.
  let constructions = 0, closes = 0, client, activeDuringConstruction;
  const cm = new workModule.RequestWorkManager();
  class FakeDatabase { constructor() { constructions++; this.open = true; void cm.stopAndDrain(); activeDuringConstruction = cm.active; client.closeDatabase(); } close() { closes++; this.open = false; } }
  client = load('src/db/client.ts', { 'better-sqlite3': FakeDatabase, '../config/env.js': { env: { DATABASE_URL:'sqlite:synthetic' } }, '../utils/logger.js': { logger:silence }, './schema.js': { SQL_SCHEMA:'' }, '../upstream/siwc-store.js': { SiwcStore: class {} }, './account-429-v2-store.js': { assert429V2Schema() { throw new Error('Unexpected v2 validation'); }, provision429V2() { throw new Error('Unexpected v2 provisioning'); } }, path: { dirname: () => 'synthetic' }, fs: { existsSync: () => true } });
  workModule.requestWork.ownedDispatch = cm.ownedDispatch.bind(cm);
  fakeClient.getDb = () => client.getDb(); checkpoint = () => {};
  const initFailure = dispatch(); assert.equal(initFailure.code,503); assert.deepEqual(initFailure.body,{error:{type:'service_unavailable',message:'Routing snapshot unavailable'}});
  assert.equal(activeDuringConstruction,1); assert.equal(constructions,1); assert.equal(closes,1); assert.equal(cm.active,0); assert.throws(() => client.getDb()); assert.equal(constructions,1);
}
