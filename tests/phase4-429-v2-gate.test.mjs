import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const Database = require('better-sqlite3');
const wall = Date.parse('2030-01-01T00:00:00Z');
class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } static now() { return wall; } }
function load(path, imports = Object.create(null)) {
  const exports = {};
  const context = vm.createContext({ exports, module: {exports}, Promise, Date: FakeDate, process: Object.freeze({env: Object.freeze(Object.create(null))}), require(name) { if (!Object.hasOwn(imports, name)) throw new Error('Unexpected import'); return imports[name]; } });
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  new vm.Script(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText).runInContext(context);
  return context.module.exports;
}
function fixture(provision = true) {
  const db = new Database(':memory:');
  const store = load('../src/db/account-429-v2-store.ts');
  db.exec(`CREATE TABLE upstream_accounts(id TEXT PRIMARY KEY,status TEXT,state_revision INTEGER,credential_revision INTEGER,daily_quota INTEGER);
  CREATE TABLE ordinary_account_attempts(account_id TEXT PRIMARY KEY,attempt_id TEXT);
  CREATE TABLE account_daily_reservations(account_id TEXT PRIMARY KEY,day TEXT,used INTEGER,legacy_ambiguous INTEGER);
  CREATE TABLE account_429_cooldowns(kind TEXT,account_id TEXT,until_at INTEGER);
  INSERT INTO upstream_accounts VALUES('A','active',1,1,0);`);
  if (provision) db.transaction(() => store.provision429V2(db)).immediate();
  let between = () => {};
  let writes = 0;
  const imports = Object.assign(Object.create(null), {
    '../db/async-writer.js': {withAsyncWriter: async fn => { if (++writes === 2) between(); return db.transaction(() => fn(db)).immediate(); }},
    '../db/account-429-v2-store.js': store,
    '../db/durable-ledger-foundation.js': {createOpenAttemptCallback: () => () => {throw new Error('unexpected ledger');}},
    './inference.js': {UpstreamError: class extends Error {constructor(status, message) {super(message); this.status=status;}}},
    './oauth.js': {decodeJwt: () => undefined, parseStoredCredentials: () => undefined},
    '../db/repositories/accounts.js': {refreshFingerprint: () => {throw new Error('unexpected refresh');}},
    'crypto': {randomUUID: () => 'test-attempt'},
  });
  const quota = load('../src/upstream/account-quota.ts', imports);
  let starts = 0;
  const account = {id:'A',provider:'anthropic',stateRevision:1,credentialRevision:1,credentials:'synthetic'};
  return {db, store, setBetween(fn) {between=fn;}, starts: () => starts, invoke: () => quota.invokeAccountAttempt(account, new AbortController().signal, () => {starts++; return Promise.resolve('ok');}), opens: () => db.prepare('SELECT count(*) AS n FROM ordinary_account_attempts').get().n};
}

test('v2 restriction blocks admission without OPEN or dispatch', async () => {
  const f=fixture(); try {
    f.db.transaction(() => f.store.arm429V2(f.db,'upstream','A',60000)).immediate();
    await assert.rejects(f.invoke(), error => error.constructor.name === 'AccountCooldownBeforeDispatch');
    assert.equal(f.starts(),0); assert.equal(f.opens(),0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM account_daily_reservations').get().n,0);
  } finally {f.db.close();}
});
test('restriction committed after admission blocks dispatch and cleans owned OPEN', async () => {
  const f=fixture(); try {
    let sawOpen = false, armed = false;
    f.setBetween(() => { sawOpen = f.opens() === 1; f.db.transaction(() => f.store.arm429V2(f.db,'upstream','A',60000)).immediate(); armed = true; });
    await assert.rejects(f.invoke(), error => error.constructor.name === 'AccountQuotaUnavailable');
    assert.equal(sawOpen,true); assert.equal(armed,true);
    assert.equal(f.starts(),0); assert.equal(f.opens(),0);
  } finally {f.db.close();}
});
test('absent and corrupt v2 schema fail closed', async () => {
  for (const corrupt of [false,true]) {
    const f=fixture(corrupt); try {
      if (corrupt) f.db.prepare('DELETE FROM account_429_v2_schema_marker').run();
      await assert.rejects(f.invoke());
      assert.equal(f.starts(),0); assert.equal(f.opens(),0);
    } finally {f.db.close();}
  }
});
test('unrestricted account dispatches normally', async () => {
  const f=fixture(); try {
    f.db.transaction(() => f.store.arm429V2(f.db,'siwc','A',60000)).immediate();
    assert.equal(await f.invoke(),'ok'); assert.equal(f.starts(),1); assert.equal(f.opens(),1);
  } finally {f.db.close();}
});
