// Isolated authenticated current-path 429 regression; no listener or live provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

// Independently reviewed targeted fixture; it does not provide a native-code sandbox.

const markers = ['synthetic-user-key-72941', 'sk-ant-api-synthetic-A-72941', 'sk-ant-api-synthetic-B-72941'];

const providerDate = 'Sun, 06 Nov 1994 08:49:37 GMT';
const absoluteHint = 'Sun, 06 Nov 1994 08:49:47 GMT';
const hintCases = [
  {name:'missing Retry-After uses five seconds', headers:{}, duration:5000},
  {name:'numeric Retry-After uses ten seconds', headers:{'retry-after':'10'}, duration:10000},
  {name:'malformed Retry-After is indefinite', headers:{'retry-after':'invalid'}, duration:null},
  {name:'excessive Retry-After is indefinite', headers:{'retry-after':'999999999999999999999'}, duration:null},
  {name:'absolute Retry-After without Date is indefinite', headers:{'retry-after':absoluteHint}, duration:null},
  {name:'absolute Retry-After with malformed Date is indefinite', headers:{'retry-after':absoluteHint, date:'invalid'}, duration:null},
  {name:'absolute Retry-After with mismatched weekday is indefinite', headers:{'retry-after':absoluteHint, date:'Mon, 06 Nov 1994 08:49:37 GMT'}, duration:null},
  {name:'provider-relative interval includes precision floor', headers:{'retry-after':absoluteHint, date:providerDate}, duration:11000, skew:0},
  {name:'forward wall skew cannot shorten provider-relative interval', headers:{'retry-after':absoluteHint, date:providerDate}, duration:11000, skew:60000},
  {name:'backward wall skew cannot shorten provider-relative interval', headers:{'retry-after':absoluteHint, date:providerDate}, duration:70000, skew:-60000},
];

if (process.argv[2] !== '--isolated') {
  async function runScenario(restart, hintIndex, indefinite = false, shutdown = false) {
    for (const mutant of shutdown || indefinite || hintIndex === undefined ? [true, false] : [false]) {
    const outcome = await new Promise(resolve => {
      let child, closed = false, status, signal, timedOut = false, overflow = false, leaked = false, streamError = false, childError = false, setupError = false, stdout = '', stderr = '', timer, grace, finished = false, killRequested = false;
      const tails = ['', ''], streamClosed = [false, false];
      const maxMarker = Math.max(...markers.map(marker => marker.length));
      const kill = () => { if (child && !closed && !killRequested) { killRequested = true; try { child.kill(); } catch { childError = true; } } };
      const done = () => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearTimeout(grace);
        resolve({closed, streamsClosed:streamClosed.every(Boolean), status, signal, timedOut, overflow, leaked, streamError, childError, setupError, stdout, stderr});
      };
      const maybeDone = () => { if (closed && streamClosed.every(Boolean)) done(); };
      try {
        const scratch = process.env.TMPDIR;
        if (!scratch || !isAbsolute(scratch)) throw new Error('Explicit absolute scratch directory required');
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated', ...(restart ? ['--restart'] : []), ...(indefinite ? ['--indefinite'] : []), ...(shutdown ? ['--shutdown-200'] : []), ...(mutant ? [shutdown ? '--shutdown-mutant' : indefinite ? '--indefinite-mutant' : restart ? '--restart-mutant' : '--early-mutant'] : []), ...(hintIndex === undefined ? [] : [`--hint-case=${hintIndex}`])], {env:{}, cwd:scratch, stdio:['ignore','pipe','pipe']});
        child.on('error', () => { childError = true; kill(); });
        child.on('close', (code, terminationSignal) => { closed = true; status = code; signal = terminationSignal; maybeDone(); });
        for (const [stream, which] of [[child.stdout, 0], [child.stderr, 1]]) {
          stream.on('error', () => { streamError = true; kill(); });
          stream.on('close', () => { streamClosed[which] = true; maybeDone(); });
        }
        timer = setTimeout(() => { timedOut = true; kill(); }, 12000);
        grace = setTimeout(() => {
          if (!closed || !streamClosed.every(Boolean)) {
            kill();
            child.stdout.destroy(); child.stderr.destroy();
            // A bounded failure is not evidence of reaping; do not keep the runner alive forever.
            child.unref(); done();
          }
        }, 15000);
        for (const [stream, which] of [[child.stdout, 0], [child.stderr, 1]]) {
          stream.setEncoding('utf8');
          stream.on('data', chunk => {
            const scan = tails[which] + chunk;
            if (markers.some(marker => scan.includes(marker))) leaked = true;
            tails[which] = scan.slice(-(maxMarker - 1));
            if (stdout.length + stderr.length + chunk.length > 65536) {
              if (!overflow) { overflow = true; kill(); }
            } else if (!overflow) { if (which) stderr += chunk; else stdout += chunk; }
          });
        }
      } catch {
        setupError = true;
        if (!child) done();
        else {
          kill();
          // Keep the same bounded close wait even when setup after spawn fails.
          if (!grace) grace = setTimeout(() => { kill(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); done(); }, 15000);
          maybeDone();
        }
      }
    });
    assert.equal(outcome.closed && outcome.streamsClosed, true, 'child closure not confirmed');
    const safe = !outcome.leaked && !markers.some(marker => outcome.stdout.includes(marker) || outcome.stderr.includes(marker));
    assert.equal(safe, true, 'fixture output contained a synthetic credential marker');
    assert.equal(!outcome.timedOut && !outcome.overflow && !outcome.streamError && !outcome.childError && !outcome.setupError && outcome.signal === null, true, 'fixture child closure failed');
    if (mutant) {
      assert.equal(outcome.status === 1 && outcome.stdout === (shutdown ? 'DRAIN_BYPASSED_BEFORE_USAGE\n' : indefinite ? 'INDEFINITE_RESTRICTION\n' : restart ? 'EARLY_AFTER_RESTART\n' : 'EARLY_BOUNDARY\n') && outcome.stderr === '', true, 'mutant did not fail at its designated assertion');
      continue;
    }
    const category = ['SHUTDOWN_RESPONSE','SHUTDOWN_WRITER','SHUTDOWN_SETUP','SHUTDOWN_HOOKS','SHUTDOWN_ADMISSION','SHUTDOWN_EARLY_CLOSE','SHUTDOWN_USAGE','SHUTDOWN_ORDER','MUTATION_MISMATCH','EARLY_AFTER_RESTART','RESTART_BEFORE','RESTART_INITIAL','RESTART_BOUNDARY','RESTART_ROUTE','RESTART_EXPIRY','RESTART_RECOVERY','EARLY_BOUNDARY','BEFORE_EXPIRY','BOUNDARY_RESTRICTION','EARLY_ELIGIBILITY','DDL','FIRST','SETTLEMENT','HINT_DURATION','OPEN','OWNERSHIP','SECOND','USER_QUOTA','THIRD','EXPIRY','FOURTH','ROLLBACK','TIMEOUT','UNEXPECTED_IMPORT','ROUTER_ERROR','NOT_FOUND','AUTH_REJECTED','PRE_FORWARD_ERROR','FORWARD_ERROR','SIWC_REFRESH_CALLED','UNKNOWN_CREDENTIAL','FIXTURE_FAILURE','CLEANUP_FAILURE'].find(value => outcome.stdout === `${value}\n` && outcome.stderr === '');
    assert.equal(outcome.status, 0, category ? `isolated fixture failed: ${category}` : 'isolated fixture failed');
    assert.equal(outcome.stdout === '' && outcome.stderr === '', true, 'unexpected fixture output');
    }
  }
  test('authenticated 429 does not expire merely because the wall clock jumps', {timeout:45000}, () => runScenario(false));
  test('authenticated 429 waits a full duration after simulated observer restart', {timeout:45000}, () => runScenario(true));
  test('authenticated malformed 429 remains restricted through expiry ticks', {timeout:45000}, () => runScenario(false, 2, true));
  test('shutdown drains post-response usage writing while retaining the database', {timeout:45000}, () => runScenario(false, undefined, false, true));
  hintCases.forEach((scenario, index) => {
    test(`authenticated 429: ${scenario.name}`, {timeout:45000}, () => runScenario(false, index));
  });
} else {
  try {
    const { createRequire, syncBuiltinESMExports } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const { EventEmitter } = await import('node:events');
    const vm = await import('node:vm');
    const require = createRequire(import.meta.url);
    // Install before loading any third-party package. IPC/stdio already exist;
    // these replacements never create a socket or listener.
    const denied = () => { throw new Error('HOST_NETWORK_DENIED'); };
    const http = require('node:http'), https = require('node:https');
    const net = require('node:net'), dns = require('node:dns');
    globalThis.fetch = denied;
    http.request = http.get = https.request = https.get = denied;
    net.Socket.prototype.connect = net.Server.prototype.listen = denied;
    dns.lookup = dns.resolve = denied;
    for (const key of Object.keys(dns)) if (key.startsWith('resolve') && typeof dns[key] === 'function') dns[key] = denied;
    dns.promises.lookup = dns.promises.resolve = denied;
    for (const key of Object.keys(dns.promises)) if (key.startsWith('resolve') && typeof dns.promises[key] === 'function') dns.promises[key] = denied;
    // Synchronize Node's ESM named built-in exports with guarded CJS exports.
    syncBuiltinESMExports();
    for (const fn of [globalThis.fetch, http.request, http.get, https.request, https.get, net.Socket.prototype.connect, net.Server.prototype.listen, dns.lookup, dns.resolve, dns.promises.lookup, dns.promises.resolve]) {
      let blocked = false;
      try { fn(); } catch (error) { blocked = error instanceof Error && error.message === 'HOST_NETWORK_DENIED'; }
      if (!blocked) throw new Error('HOST_GUARD_FAILURE');
    }
    const ts = require('typescript');
    const NativeDatabase = require('better-sqlite3');
    function Database(name, options) {
      if (name !== ':memory:' || options !== undefined) throw new Error('MEMORY_ONLY');
      return new NativeDatabase(':memory:');
    }
    const express = require('express');
    const crypto = require('node:crypto');

    const db = new Database(':memory:');
    let manager, expiry, primary = '', cleanupFailed = false, releaseWriter, pendingForward, shutdownStarted = false, shutdownClosed, shutdownDone, closeListener, context, processShim, fakeProcess, deadlineFired = false;
    const shutdownTimers = new Set();
    const check = (value, category) => { if (!value) throw new Error(category); };
    const bounded = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 3000); })]); }
      finally { clearTimeout(timer); }
    };
    try {
      const hintArg = process.argv.find(arg => arg.startsWith('--hint-case='));
      const hintCase = hintArg === undefined ? undefined : hintCases[Number(hintArg.slice('--hint-case='.length))];
      check(hintArg === undefined || hintCase !== undefined, 'FIXTURE_FAILURE');
      let wall = hintCase ? Date.parse('1994-11-06T08:49:37.000Z') + (hintCase.skew ?? 0) : Date.parse('2031-07-01T00:00:00.000Z');
      let monotonic = 5000000000n;
      class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } static now() { return wall; } }
      const logger = Object.freeze({debug(){}, info(){}, warn(){}, error(){}});
      processShim = Object.freeze({env:Object.freeze(Object.create(null)), hrtime:Object.freeze({bigint:() => monotonic})});
      let unknownCredential = false, ownedAttempt;
      const localFetch = async (_url, options) => {
        const token = options?.headers?.['x-api-key'];
        const id = token === markers[1] ? 'A' : token === markers[2] ? 'B' : token === 'synthetic-control-key-72941' ? 'C' : null;
        if (!id) { unknownCredential = true; throw new Error('UNKNOWN_CREDENTIAL'); }
        calls.push(id);
        if (id === 'A') ownedAttempt = db.prepare('SELECT account_id,attempt_id FROM ordinary_account_attempts').get();
        if (id === 'A' && !process.argv.includes('--shutdown-200')) return new Response(null, {status:429, headers:hintCase ? hintCase.headers : {'retry-after':'10'}});
        const events = [
          {type:'message_start',message:{id:'synthetic',content:[],usage:{input_tokens:1}}},
          {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
          {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture answer'}},
          {type:'content_block_stop',index:0},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
          {type:'message_stop'},
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
        return new Response(events, {status:200,headers:{'content-type':'text/event-stream'}});
      };
      const calls = [];
      context = vm.createContext({Date:FakeDate, process:processShim, console:Object.freeze({}), Promise, Buffer, AbortController, Response, TransformStream, TextDecoder, setTimeout, clearTimeout, fetch:localFetch});
      const read = path => readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8');
      function load(path, dependencies = {}) {
        let input = read(path);
        if (path === 'server' && process.argv.includes('--shutdown-200')) {
          const expression = 'shutdownDeadline = setTimeout(';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, 'shutdownDeadline = __shutdownTimer(');
          const continuation = 'void Promise.all(drains).then(';
          check(input.split(continuation).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(continuation, 'globalThis.__shutdownContinuation = Promise.all(drains).then(');
        }
        if (path === 'db/account-429-v2-expiry' && process.argv.includes('--early-mutant')) {
          for (const expression of ['now - observation.since < row.duration_ms * 1000000n', 'lockedNow - observation.since < row.duration_ms * 1000000n']) {
            check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
            input = input.replace(expression, expression + ' - 1n');
          }
        }
        if (path === 'db/account-429-v2-expiry' && process.argv.includes('--restart-mutant')) {
          const expression = 'this.observations.set(key, {row, since: this.sample()});';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, 'this.observations.set(key, {row, since: this.sample() - (globalThis.fixtureRestarted ? 5000000000n : 0n)});');
        }
        if (path === 'db/account-429-v2-expiry' && process.argv.includes('--indefinite-mutant')) {
          const expression = 'if (row.duration_ms === null || this.observations.has(key) || this.observations.size >= this.o.maxObservations) continue;';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, "if (row.duration_ms === null) { db.prepare('DELETE FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=? AND generation=? AND duration_ms IS NULL').run(row.kind, row.account_id, row.generation); continue; }\n      if (this.observations.has(key) || this.observations.size >= this.o.maxObservations) continue;");
        }
        if (path === 'server' && process.argv.includes('--shutdown-mutant')) {
          const expression = '    requestDrain,\n';
          check(input.split(expression).length === 2, 'MUTATION_MISMATCH');
          input = input.replace(expression, '    Promise.resolve(true),\n');
        }
        const source = ts.transpileModule(input, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
        const exports = {};
        const factory = new vm.Script(`(function(exports, require, module){${source}\n})`, {filename:`${path}.ts`}).runInContext(context);
        const module = {exports};
        factory(exports, name => { if (!Object.hasOwn(dependencies, name)) throw new Error('UNEXPECTED_IMPORT'); return dependencies[name]; }, module);
        return module.exports;
      }
      const schema = load('db/schema'); db.exec(schema.SQL_SCHEMA);
      db.exec('ALTER TABLE upstream_accounts ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0');
      const clientSource = read('db/client');
      for (const name of ['COOLDOWN_TABLE_SQL','ORDINARY_ATTEMPTS_SQL']) {
        const match = clientSource.match(new RegExp(`const ${name} = \\x60([\\s\\S]*?)\\x60;`));
        check(!!match, 'DDL'); db.exec(match[1]);
      }
      for (const name of ['account_daily_reservations','user_daily_quota']) {
        const match = clientSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`));
        check(!!match, 'DDL'); db.exec(match[0]);
      }
      db.pragma('foreign_keys = ON');
      const client = {getDb:() => db, requireInitializedDatabase:() => db};
      const env = {env:{ENCRYPTION_KEY:'00'.repeat(32), NODE_ENV:'test'}};
      const encryption = load('utils/encryption', {crypto, '../config/env.js':env});
      const writer = load('db/async-writer', {'better-sqlite3':Database, './client.js':client, '../utils/logger.js':{logger}});
      const v2 = load('db/account-429-v2-store');
      writer.withAsyncWriter(connection => v2.provision429V2(connection));
      const expiryModule = load('db/account-429-v2-expiry', {'./client.js':client, './async-writer.js':writer, './account-429-v2-store.js':v2});
      const expiryOptions = {onFailure:() => { throw new Error('EXPIRY_FAILURE'); }, monotonic:() => monotonic, setTimer:() => { throw new Error('UNEXPECTED_TIMER'); }, clearTimer:() => {}, intervalMs:1000, maxObservations:10, scanBatch:10};
      expiry = new expiryModule.Account429V2Expiry(expiryOptions);
      const work = load('request-work', {'node:async_hooks':require('node:async_hooks')});
      manager = new work.RequestWorkManager();
      const oauth = load('upstream/oauth', {crypto, http:Object.freeze({}), '../utils/logger.js':{logger}});
      const accounts = load('db/repositories/accounts', {'../client.js':client, crypto, '../../upstream/oauth.js':oauth, '../../utils/encryption.js':encryption});
      const users = load('db/repositories/users', {'../client.js':client, crypto});
      const usageUtc = load('db/usage-utc');
      const usage = load('db/repositories/usage-logs', {'../client.js':client, crypto, '../usage-utc.js':usageUtc});
      const settings = load('db/repositories/settings', {'../client.js':client});
      const siwcStore = load('upstream/siwc-store', {'better-sqlite3':Database, 'node:crypto':crypto});
      // This fixture covers ordinary Anthropic API-key accounts only.
      let refreshCalls = 0;
      const siwcRefresh = Object.freeze({refreshSiwcSnapshot() { refreshCalls++; throw new Error('SIWC_REFRESH_DENIED'); }});
      const pool = load('account-pool/manager', {'../db/repositories/accounts.js':accounts, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/logger.js':{logger}, '../utils/encryption.js':encryption, '../upstream/siwc-store.js':siwcStore, '../upstream/oauth.js':oauth, '../db/usage-utc.js':usageUtc});
      const tokens = load('upstream/tokens', {'../db/repositories/accounts.js':accounts, '../db/async-writer.js':writer, '../utils/logger.js':{logger}, './oauth.js':oauth});
      const inference = load('upstream/inference');
      const ledger = load('db/durable-ledger-foundation', {'better-sqlite3':Database, 'node:crypto':crypto});
      const quota = load('upstream/account-quota', {'../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../db/durable-ledger-foundation.js':ledger, './inference.js':inference, './oauth.js':oauth, '../db/repositories/accounts.js':accounts, crypto});
      const deadline = load('upstream/ordinary-429-deadline');
      const forward = load('upstream/forward-chat', {crypto, events:require('node:events'), '../account-pool/manager.js':pool, '../db/repositories/usage-logs.js':usage, '../db/repositories/accounts.js':accounts, '../utils/logger.js':{logger}, './tokens.js':tokens, './inference.js':inference, './account-quota.js':quota, '../db/client.js':client, '../db/async-writer.js':writer, '../db/account-429-v2-store.js':v2, '../utils/encryption.js':encryption, './siwc-store.js':siwcStore, './siwc-refresh.js':siwcRefresh, '../db/repositories/settings.js':settings, './ordinary-429-deadline.js':deadline});
      const auth = load('auth/user-auth', {'../db/repositories/users.js':users, '../utils/encryption.js':encryption, '../utils/logger.js':{logger}, '../config/env.js':env, '../db/async-writer.js':writer, '../request-work.js':{requestWork:manager}});
      const router = load('routes/v1', {express, '../config/env.js':env, '../auth/user-auth.js':auth, '../request-work.js':{requestWork:manager}, '../utils/logger.js':{logger}, '../upstream/forward-chat.js':{forwardChat:async (req,res) => { req.fixtureEntered(); try { return await forward.forwardChat(req,res); } catch (error) { req.fixtureFailed(); throw error; } finally { req.fixtureFinished(); } }}}).default;
      const user = new users.UserRepository().create({apiKeyHash:encryption.hashApiKey(markers[0]),name:'fixture',email:'fixture@example.invalid',tier:'free',dailyLimit:10});
      const repo = new accounts.AccountRepository();
      const a = repo.create({name:'A',provider:'anthropic',credentialType:'api_key',credentials:markers[1],priority:0});
      const b = repo.create({name:'B',provider:'anthropic',credentialType:'api_key',credentials:markers[2],priority:1});
      function startRequest() {
        let finish, completed;
        let forwardEntered = false, forwardFailed = false, routerError = false, unmatched = false;
        const responseDone = new Promise(resolve => { finish = resolve; });
        const forwardDone = new Promise(resolve => { completed = resolve; });
        const res = Object.assign(new EventEmitter(), {statusCode:200, destroyed:false, writableEnded:false, headersSent:false, headers:{}, status(code){this.statusCode=code;return this;}, setHeader(k,v){this.headers[k.toLowerCase()]=v;}, getHeader(k){return this.headers[k.toLowerCase()];}, json(body){this.body=body;this.headersSent=true;this.writableEnded=true;finish();return this;}, destroy(){this.destroyed=true;finish();}});
        const req = {method:'POST',url:'/chat/completions',headers:{authorization:`Bearer ${markers[0]}`},body:{model:'claude-fixture',messages:[{role:'user',content:'hello'}]},fixtureFinished:completed};
        req.fixtureEntered = () => { forwardEntered = true; };
        req.fixtureFailed = () => { forwardFailed = true; };
        router.handle(req,res,error => { routerError = !!error; unmatched = !error; if (!res.writableEnded) res.status(error ? 500 : 404).json({}); });
        return {res, responseDone, forwardDone, audit:() => ({forwardEntered, forwardFailed, routerError, unmatched})};
      }
      function auditRequest(result, expectForward = true) {
        const {res} = result;
        const {forwardEntered, forwardFailed, routerError, unmatched} = result.audit();
        check(!unknownCredential, 'UNKNOWN_CREDENTIAL');
        check(refreshCalls === 0, 'SIWC_REFRESH_CALLED');
        check(!routerError, 'ROUTER_ERROR');
        check(!unmatched, 'NOT_FOUND');
        check(forwardEntered === expectForward, res.statusCode === 401 || res.statusCode === 403 ? 'AUTH_REJECTED' : 'PRE_FORWARD_ERROR');
        check(!forwardFailed, 'FORWARD_ERROR');
      }
      async function request() {
        const result = startRequest();
        const {res, responseDone, forwardDone} = result;
        await bounded(responseDone);
        if (result.audit().forwardEntered) await bounded(forwardDone);
        auditRequest(result);
        return res;
      }
      const success = res => res.statusCode === 200 && res.body?.object === 'chat.completion' && res.body?.model === 'claude-fixture' && res.body?.choices?.length === 1 && res.body.choices[0].message?.role === 'assistant' && res.body.choices[0].message?.content === 'fixture answer' && res.body.choices[0].finish_reason === 'stop';
      if (process.argv.includes('--shutdown-200')) {
        const events = [];
        let entered;
        const writerEntered = new Promise(resolve => { entered = resolve; });
        const writerGate = new Promise(resolve => { releaseWriter = resolve; });
        const closed = shutdownDone = new Promise(resolve => { shutdownClosed = resolve; });
        const originalWriter = writer.withAsyncWriter;
        const originalSuccess = pool.accountPool.recordSuccessAsync;
        const originalCreate = usage.UsageLogRepository.prototype.create;
        let armed = false, successFinished = false, usageEntered = false, usageArgs, usageRow, writerError;
        pool.accountPool.recordSuccessAsync = async function (...args) {
          const value = await originalSuccess.apply(this, args);
          successFinished = true; events.push('account-success-settled'); armed = true;
          return value;
        };
        usage.UsageLogRepository.prototype.create = function (...args) {
          usageEntered = true; usageArgs = args; events.push('usage-create-entered');
          const value = originalCreate.apply(this, args);
          usageRow = value; events.push('usage-create-returned');
          return value;
        };
        writer.withAsyncWriter = (...args) => {
          if (!armed) return originalWriter(...args);
          armed = false;
          events.push('writer-entered'); entered();
          return writerGate.then(() => {
            events.push('writer-released');
            try { return originalWriter(...args); }
            catch (error) { writerError = error; events.push('writer-error'); throw error; }
          });
        };
        const result = startRequest();
        pendingForward = result.forwardDone;
        await bounded(result.responseDone);
        check(success(result.res) && JSON.stringify(calls) === '["A"]', 'SHUTDOWN_RESPONSE');
        await bounded(writerEntered);
        check(successFinished && !armed && !usageEntered && db.open && db.prepare('SELECT count(*) n FROM usage_logs').get().n === 0, 'SHUTDOWN_WRITER');

        const listener = new EventEmitter();
        let closeCallback, actualDrain, snapshot, listenerStarted;
        listener.close = callback => { events.push('listener-close'); closeCallback = callback; closeListener = () => { if (closeCallback) { const callback = closeCallback; closeCallback = undefined; events.push('listener-closed'); callback(); } }; };
        listener.closeAllConnections = () => { throw new Error('UNEXPECTED_DEADLINE'); };
        const appFactory = Object.assign(() => { const app = express(); app.listen = (_port, _host, callback) => { listenerStarted=callback; return listener; }; return app; }, {json:express.json});
        fakeProcess = Object.assign(new EventEmitter(), {env:processShim.env, hrtime:processShim.hrtime, exitCode:0, exit:() => { deadlineFired = true; events.push('deadline-exit'); }});
        const originalDrain = manager.stopAndDrain.bind(manager);
        manager.stopAndDrain = () => {
          events.push('request-drain');
          actualDrain = originalDrain();
          return actualDrain;
        };
        const fakeClient = {
          ...client, initDatabase:() => { check(db.open, 'SHUTDOWN_SETUP'); },
          closeDatabase:() => {
            snapshot = db.prepare('SELECT id,user_id,upstream_account_id,model,provider,input_tokens,output_tokens,usage_known,success FROM usage_logs').all();
            events.push('db-close'); db.close();
          },
        };
        const stop = name => () => { events.push(name); return Promise.resolve().then(() => { events.push(`${name}-settled`); }); };
        class FakeExpiry { start() { events.push('expiry-start'); } stopAndDrain() { return stop('expiry-stop')(); } }
        context.process = fakeProcess;
        context.__shutdownTimer = (fn, delay, ...args) => {
          check(shutdownStarted && delay === 5000, 'SHUTDOWN_SETUP');
          const handle = setTimeout(() => { shutdownTimers.delete(handle); fn(...args); }, delay);
          const originalUnref = handle.unref.bind(handle);
          handle.unref = () => { events.push('deadline-unref'); shutdownClosed(); return originalUnref(); };
          shutdownTimers.add(handle);
          return handle;
        };
        context.clearTimeout = handle => { shutdownTimers.delete(handle); clearTimeout(handle); };
          load('server', {
            express:appFactory, './config/env.js':env, './utils/logger.js':{logger},
            './upstream/oauth.js':{stopOAuth:stop('oauth-stop')},
            './upstream/siwc-login.js':{stopSiwc:stop('siwc-stop'), noStoreSiwc:(_req,_res,next) => next()},
            './upstream/tokens.js':{drainTokenRefreshes:stop('token-stop')},
            './request-work.js':{requestWork:manager, trackedErrorHandler:(handler) => work.trackedErrorHandler(handler, manager)},
            './db/client.js':fakeClient, './db/async-writer.js':{retryQuarantinedWriters:() => events.push('writers-retried')},
            './db/account-429-v2-store.js':v2, './db/account-429-v2-expiry.js':{Account429V2Expiry:FakeExpiry},
            './routes/v1.js':router, './routes/admin.js':express.Router(),
          });
        check(typeof listenerStarted === 'function', 'SHUTDOWN_SETUP');
        listenerStarted();
        check(events.includes('expiry-start') && fakeProcess.listenerCount('SIGTERM') === 1, 'SHUTDOWN_SETUP');
        shutdownStarted = true;
        fakeProcess.emit('SIGTERM');
        manager.stopAndDrain = originalDrain;
        check(typeof closeCallback === 'function' && actualDrain && ['request-drain','token-stop','expiry-stop','oauth-stop','siwc-stop','listener-close'].every(e => events.includes(e)), 'SHUTDOWN_HOOKS');
        const rejected = startRequest();
        await bounded(rejected.responseDone);
        auditRequest(rejected, false);
        check(rejected.res.statusCode === 503 && JSON.stringify(calls) === '["A"]', 'SHUTDOWN_ADMISSION');
        closeListener();
        await Promise.resolve();
        check(['token-stop-settled','expiry-stop-settled','oauth-stop-settled','siwc-stop-settled'].every(e => events.includes(e)), 'SHUTDOWN_HOOKS');
        events.push('other-drains-settled');
        check(manager.run(() => { throw new Error('UNEXPECTED_ADMISSION'); }) === undefined, 'SHUTDOWN_ADMISSION');
        if (process.argv.includes('--shutdown-mutant')) {
          await bounded(closed);
          check(context.__shutdownContinuation, 'SHUTDOWN_HOOKS');
          await bounded(context.__shutdownContinuation);
          check(db.open && !usageEntered && !events.includes('db-close') && events.includes('deadline-unref') && !events.includes('writer-released'), 'SHUTDOWN_MUTANT');
          releaseWriter();
          await bounded(pendingForward);
          await bounded(actualDrain);
          check(!writerError && usageEntered && usageRow && db.open && db.prepare('SELECT count(*) n FROM usage_logs').get().n === 1 && events.indexOf('deadline-unref') < events.indexOf('writer-released'), 'SHUTDOWN_MUTANT');
          throw new Error('DRAIN_BYPASSED_BEFORE_USAGE');
        }
        check(db.open && db.prepare('SELECT count(*) n FROM usage_logs').get().n === 0 && !events.includes('db-close') && !events.includes('deadline-unref'), 'SHUTDOWN_EARLY_CLOSE');
        releaseWriter();
        await bounded(pendingForward);
        auditRequest(result);
        await bounded(actualDrain);
        await bounded(closed);
        check(context.__shutdownContinuation, 'SHUTDOWN_HOOKS');
        await bounded(context.__shutdownContinuation);
        snapshot = db.prepare('SELECT id,user_id,upstream_account_id,model,provider,input_tokens,output_tokens,usage_known,success FROM usage_logs').all();
        check(!writerError && usageEntered && usageRow && usageArgs[1] === db && usageArgs[0].userId === user.id && usageArgs[0].upstreamAccountId === a.id && usageArgs[0].model === 'claude-fixture' && usageArgs[0].provider === 'anthropic' && usageArgs[0].inputTokens === 1 && usageArgs[0].outputTokens === 1 && usageArgs[0].success === true && db.open && snapshot.length === 1 && snapshot[0].id === usageRow.id && snapshot[0].user_id === user.id && snapshot[0].upstream_account_id === a.id && snapshot[0].model === 'claude-fixture' && snapshot[0].provider === 'anthropic' && snapshot[0].input_tokens === 1 && snapshot[0].output_tokens === 1 && snapshot[0].usage_known === 1 && snapshot[0].success === 1, 'SHUTDOWN_USAGE');
        const order = ['account-success-settled','writer-entered','request-drain','listener-closed','other-drains-settled','writer-released','usage-create-entered','usage-create-returned','deadline-unref'].map(e => events.indexOf(e));
        check(order.every((value, index) => value >= 0 && (!index || order[index - 1] < value)), 'SHUTDOWN_ORDER');
      } else {
      const first = await request();
      check(first.statusCode === 429 && JSON.stringify(calls) === '["A"]', 'FIRST');
      check(ownedAttempt?.account_id === a.id && typeof ownedAttempt.attempt_id === 'string', 'OWNERSHIP');
      if (hintCase) {
        const rows = db.prepare('SELECT kind,account_id,generation,duration_ms FROM account_429_v2_restrictions').all();
        check(rows.length === 1 && rows[0].kind === 'upstream' && rows[0].account_id === a.id && rows[0].generation === 1 && rows[0].duration_ms === hintCase.duration, 'HINT_DURATION');
        check(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
        if (process.argv.includes('--indefinite')) {
          const original = rows[0];
          const c = repo.create({name:'C',provider:'anthropic',credentialType:'api_key',credentials:'synthetic-control-key-72941',priority:2});
          writer.withAsyncWriter(connection => v2.arm429V2(connection, 'upstream', c.id, 1000));
          const restriction = id => db.prepare('SELECT kind,account_id,generation,duration_ms FROM account_429_v2_restrictions WHERE kind=? AND account_id=?').get('upstream', id);
          const unchanged = () => JSON.stringify(restriction(a.id)) === JSON.stringify(original) && db.prepare('SELECT generation FROM account_429_v2_counter WHERE id=1').get().generation === 2;
          check(a.id !== b.id && b.id !== c.id && restriction(c.id)?.duration_ms === 1000, 'INDEFINITE_CONTROL');
          await expiry.tick();
          check(unchanged(), 'INDEFINITE_RESTRICTION');
          const second = await request();
          check(success(second) && JSON.stringify(calls) === '["A","B"]', 'INDEFINITE_ROUTE');
          monotonic += 1000000000n;
          await expiry.tick();
          check(unchanged(), 'INDEFINITE_RESTRICTION');
          check(restriction(c.id) === undefined, 'INDEFINITE_CONTROL');
          const third = await request();
          check(success(third) && JSON.stringify(calls) === '["A","B","B"]', 'INDEFINITE_ROUTE');
          monotonic = 9007199254740993000n;
          await expiry.tick();
          check(unchanged(), 'INDEFINITE_RESTRICTION');
          const fourth = await request();
          check(success(fourth) && JSON.stringify(calls) === '["A","B","B","B"]', 'INDEFINITE_ROUTE');
          check(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
        }
      } else {
      const cooldown = db.prepare("SELECT kind,account_id,generation,duration_ms FROM account_429_v2_restrictions").all();
      check(cooldown.length === 1 && cooldown[0].kind === 'upstream' && cooldown[0].account_id === a.id && cooldown[0].duration_ms === 10000 && cooldown[0].generation === 1 && db.prepare('SELECT generation FROM account_429_v2_counter WHERE id=1').get().generation === 1, 'SETTLEMENT');
      check(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
      await expiry.tick();
      const second = await request();
      check(success(second) && JSON.stringify(calls) === '["A","B"]', 'SECOND');
      check(db.prepare('SELECT used FROM user_daily_quota WHERE user_id=?').get(user.id).used === 2, 'USER_QUOTA');
      check(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
      if (process.argv.includes('--restart')) {
        // Simulated observer restart only: same owned in-memory DB, new pool and clock epoch.
        monotonic += 5000000000n;
        await expiry.tick();
        const rows = () => db.prepare('SELECT kind,account_id,generation,duration_ms FROM account_429_v2_restrictions').all();
        check(JSON.stringify(rows()) === JSON.stringify(cooldown), 'RESTART_BEFORE');
        await bounded(expiry.stopAndDrain());
        pool.accountPool = new pool.AccountPoolManager();
        monotonic = 0n;
        context.fixtureRestarted = true;
        expiry = new expiryModule.Account429V2Expiry(expiryOptions);
        await expiry.tick();
        check(JSON.stringify(rows()) === JSON.stringify(cooldown), 'RESTART_INITIAL');
        wall += 60001;
        monotonic = 9999999999n;
        await expiry.tick();
        const boundaryRows = rows();
        const beforeRestartExpiry = await request();
        if (beforeRestartExpiry.statusCode === 429 && JSON.stringify(calls) === '["A","B","A"]') throw new Error('EARLY_AFTER_RESTART');
        check(JSON.stringify(boundaryRows) === JSON.stringify(cooldown), 'RESTART_BOUNDARY');
        check(success(beforeRestartExpiry) && JSON.stringify(calls) === '["A","B","B"]', 'RESTART_ROUTE');
        wall -= 20000;
        monotonic = 10000000000n;
        await expiry.tick();
        check(rows().length === 0, 'RESTART_EXPIRY');
        const afterRestartExpiry = await request();
        check(afterRestartExpiry.statusCode === 429 && JSON.stringify(calls) === '["A","B","B","A"]', 'RESTART_RECOVERY');
        check(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
      } else {
      wall += 60001;
      await expiry.tick();
      const third = await request();
      if (third.statusCode === 429 && JSON.stringify(calls) === '["A","B","A"]') throw new Error('EARLY_ELIGIBILITY');
      check(success(third) && JSON.stringify(calls) === '["A","B","B"]', 'THIRD');
      check(a.id !== b.id && db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
      monotonic += 9999999999n;
      await expiry.tick();
      const boundaryRestriction = db.prepare('SELECT kind,account_id,generation,duration_ms FROM account_429_v2_restrictions').all();
      const beforeExpiry = await request();
      if (beforeExpiry.statusCode === 429 && JSON.stringify(calls) === '["A","B","B","A"]') throw new Error('EARLY_BOUNDARY');
      check(success(beforeExpiry) && JSON.stringify(calls) === '["A","B","B","B"]', 'BEFORE_EXPIRY');
      check(boundaryRestriction.length === 1 && boundaryRestriction[0].kind === 'upstream' && boundaryRestriction[0].account_id === a.id && boundaryRestriction[0].generation === 1 && boundaryRestriction[0].duration_ms === 10000, 'BOUNDARY_RESTRICTION');
      check(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n === 0, 'OPEN');
      monotonic += 1n;
      await expiry.tick();
      check(db.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n === 0, 'EXPIRY');
      const fourth = await request();
      check(fourth.statusCode === 429 && JSON.stringify(calls) === '["A","B","B","B","A"]', 'FOURTH');
      await expiry.tick();
      monotonic += 10000000000n;
      await expiry.tick();
      wall += 60001;
      db.exec("CREATE TRIGGER fail_fixture_close BEFORE DELETE ON ordinary_account_attempts WHEN EXISTS (SELECT 1 FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=OLD.account_id AND generation=3 AND duration_ms=10000) AND (SELECT generation FROM account_429_v2_counter WHERE id=1)=3 BEGIN SELECT RAISE(ABORT, 'fixture close failure'); END");
      const failed = await request();
      const open = db.prepare('SELECT account_id,attempt_id FROM ordinary_account_attempts').get();
      check(failed.statusCode === 503 && JSON.stringify(calls) === '["A","B","B","B","A","A"]' && open?.account_id === a.id && open.attempt_id === ownedAttempt.attempt_id && db.prepare('SELECT count(*) n FROM account_429_v2_restrictions').get().n === 0 && db.prepare('SELECT generation FROM account_429_v2_counter WHERE id=1').get().generation === 2, 'ROLLBACK');
      }
      }
      }
      await expiry.stopAndDrain();
      check(refreshCalls === 0, 'SIWC_REFRESH_CALLED');
    } catch (error) {
      primary = error instanceof Error && ['DRAIN_BYPASSED_BEFORE_USAGE','SHUTDOWN_RESPONSE','SHUTDOWN_WRITER','SHUTDOWN_SETUP','SHUTDOWN_HOOKS','SHUTDOWN_ADMISSION','SHUTDOWN_MUTANT','SHUTDOWN_EARLY_CLOSE','SHUTDOWN_USAGE','SHUTDOWN_ORDER','INDEFINITE_RESTRICTION','INDEFINITE_CONTROL','INDEFINITE_ROUTE','MUTATION_MISMATCH','EARLY_AFTER_RESTART','RESTART_BEFORE','RESTART_INITIAL','RESTART_BOUNDARY','RESTART_ROUTE','RESTART_EXPIRY','RESTART_RECOVERY','EARLY_BOUNDARY','BEFORE_EXPIRY','BOUNDARY_RESTRICTION','EARLY_ELIGIBILITY','DDL','FIRST','SETTLEMENT','HINT_DURATION','OPEN','OWNERSHIP','SECOND','USER_QUOTA','THIRD','EXPIRY','FOURTH','ROLLBACK','TIMEOUT','UNEXPECTED_IMPORT','ROUTER_ERROR','NOT_FOUND','AUTH_REJECTED','PRE_FORWARD_ERROR','FORWARD_ERROR','SIWC_REFRESH_CALLED','UNKNOWN_CREDENTIAL'].includes(error.message) ? error.message : 'FIXTURE_FAILURE';
    } finally {
      releaseWriter?.();
      try { closeListener?.(); } catch { cleanupFailed = true; }
      if (pendingForward) { try { await bounded(pendingForward); } catch { cleanupFailed = true; } }
      if (expiry) { try { await bounded(expiry.stopAndDrain()); } catch { cleanupFailed = true; } }
      if (manager) { try { await bounded(manager.stopAndDrain()); } catch { cleanupFailed = true; } }
      if (shutdownStarted) { try { await bounded(shutdownDone); } catch { cleanupFailed = true; } }
      if (shutdownStarted) { try { if (!context.__shutdownContinuation) throw new Error('missing shutdown continuation'); await bounded(context.__shutdownContinuation); } catch { cleanupFailed = true; } }
      if (deadlineFired || (fakeProcess && fakeProcess.exitCode !== 0)) cleanupFailed = true;
      // Retain the fake process if any drain did not settle; cancel owned deadlines.
      for (const timer of shutdownTimers) clearTimeout(timer);
      shutdownTimers.clear();

      if (!cleanupFailed && db.open) { try { db.close(); if (db.open) cleanupFailed = true; } catch { cleanupFailed = true; } }
      if (!cleanupFailed && fakeProcess) context.process = processShim;
    }
    if (cleanupFailed) { process.stdout.write('CLEANUP_FAILURE\n'); process.exitCode = 1; }
    else if (primary) { process.stdout.write(`${primary}\n`); process.exitCode = 1; }
  } catch { process.stdout.write('FIXTURE_FAILURE\n'); process.exitCode = 1; }
}
