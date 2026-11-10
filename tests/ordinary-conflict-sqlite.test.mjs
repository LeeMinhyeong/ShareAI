// Focused synthetic regression: no application configuration, network, or file DB.
// Production modules are transpiled unchanged; only their dependencies are injected.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
// Establish an isolated environment before loading any non-builtin module.
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
for (const key of Object.keys(process.env)) delete process.env[key];
const {default: ts} = await import('typescript');
const {default: Database} = await import('better-sqlite3');

const require = createRequire(import.meta.url);
const compile = relative => ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const writerCode = compile('../src/db/async-writer.ts');
const quotaCode = compile('../src/upstream/account-quota.ts');
const schemaCode = compile('../src/db/schema.ts');
const clientCode = compile('../src/db/client.ts');
const storeCode = compile('../src/upstream/siwc-store.ts');
function load(code, dependencies) {
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  });
  return exports;
}
function fixture(mode, injectFailure = false, hooks = {}) {
  // The real initializer and SIWC schema run with injected config/filesystem and
  // a constructor that permits exactly one owned in-memory SQLite connection.
  let db;
  let created = false, closed = false;
  const close = () => {
    if (!created || closed) return;
    try { (hooks.close ?? (connection => connection.close()))(db); }
    finally { closed = !db.open; }
    if (!closed) throw new Error('fixture connection remains open after close');
  };
  class MemoryOnly {
    constructor(path) {
      assert.equal(path, ':memory:');
      assert.equal(db, undefined);
      db = new Database(':memory:');
      created = true;
      hooks.afterOpen?.(db);
      return db;
    }
  }
  try {
  const schema = load(schemaCode, {});
  const store = load(storeCode, {'better-sqlite3':{default:MemoryOnly}, 'node:crypto':require('node:crypto')});
  const client = load(clientCode, {
    'better-sqlite3':{default:MemoryOnly}, '../config/env.js':{env:{DATABASE_URL:'sqlite::memory:'}},
    '../utils/logger.js':{logger:{info(){}}}, './schema.js':schema, '../upstream/siwc-store.js':store,
    'path':{default:{dirname:()=>'.'}}, 'fs':{default:{existsSync:()=>true, mkdirSync:()=>{throw new Error('filesystem denied');}}},
  });
  assert.equal(client.initDatabase(), db);
  assert.equal(db.name, ':memory:');
  db.exec('CREATE TABLE write_audit (operation TEXT)');
  // Added only after initialization; these test triggers are not production schema.
  for (const table of ['ordinary_account_attempts', 'account_daily_reservations']) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER audit_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO write_audit VALUES ('${table} ${operation}'); END`);
    }
  }
  const account = {id:'synthetic', provider:'openai', credentials:'synthetic', stateRevision:0, credentialRevision:0};
  db.prepare("INSERT INTO upstream_accounts (id,name,provider,credential_type,credentials,status,daily_quota,quota_reset_at) VALUES (?,?,'openai','api_key','synthetic','active',1,'2026-01-01')").run(account.id, account.id);
  if (mode === 'open') db.prepare('INSERT INTO ordinary_account_attempts VALUES (?, ?)').run(account.id, 'existing');
  if (mode === 'cooldown') db.prepare('INSERT INTO account_429_cooldowns VALUES (?, ?, ?, ?, ?)').run('upstream', account.id, Date.now(), Date.now() + 600000, 1);
  if (mode === 'exhausted') db.prepare('INSERT INTO account_daily_reservations VALUES (?, ?, 1, 0)').run(account.id, new Date().toISOString().slice(0,10));
  db.exec('DELETE FROM write_audit');
  const snapshot = () => ({open:db.prepare('SELECT * FROM ordinary_account_attempts').all(), reservations:db.prepare('SELECT * FROM account_daily_reservations').all(), audit:db.prepare('SELECT * FROM write_audit').all()});
  const totalChanges = () => db.prepare('SELECT total_changes() AS n').get().n;
  let completedCommits = 0, operationsCompleted = 0, injected;
  // This adapter only instruments transaction completion. Its methods use the
  // owned connection; the actual production withAsyncWriter executes unchanged.
  const shared = {
    get inTransaction() { return db.inTransaction; },
    get name() { return db.name; },
    transaction(operation) {
      const tx = db.transaction(() => {
        const result = operation();
        operationsCompleted++;
        // Simulated failure at the end of the writer callback before COMMIT.
        // SQLite rolls this transaction back; this is NOT a real COMMIT failure.
        if (injectFailure) { injected = new quota[mode === 'open' ? 'AccountAttemptOpen' : mode === 'cooldown' ? 'AccountCooldownBeforeDispatch' : 'AccountQuotaExhausted'](); throw injected; }
        return result;
      });
      return {immediate() { const result = tx.immediate(); completedCommits++; return result; }};
    },
    prepare(sql) { return db.prepare(sql); },
  };
  const writer = load(writerCode, {'better-sqlite3':{default:Database}, '../utils/logger.js':{logger:{error(){}}}, './client.js':{getDb:()=>shared, requireInitializedDatabase:()=>{client.requireInitializedDatabase(); return shared;}}});
  class UpstreamError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const quota = load(quotaCode, {
    '../db/async-writer.js':writer,
    '../db/durable-ledger-foundation.js':{createOpenAttemptCallback:()=>{ throw new Error('unexpected ledger path'); }},
    './inference.js':{UpstreamError},
    './oauth.js':{parseStoredCredentials:()=>null,decodeJwt:()=>null},
    '../db/repositories/accounts.js':{refreshFingerprint:()=>{ throw new Error('unexpected refresh path'); }},
    'crypto':require('node:crypto'),
  });
  return {db, close, account, quota, snapshot, totalChanges, state:()=>({completedCommits,operationsCompleted,injected})};
  } catch (error) {
    try { close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture setup and cleanup failed');
    }
    throw error;
  }
}

async function withFixture(mode, injectFailure, body, hooks) {
  const f = fixture(mode, injectFailure, hooks);
  let failed = false, primary;
  try { return await body(f); }
  catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { f.close(); }
    catch (cleanupError) {
      if (failed) throw new AggregateError([primary, cleanupError], 'fixture body and cleanup failed');
      throw cleanupError;
    }
  }
}

test('fixture rejects a close hook that returns while connection stays open', async () => {
  let owned;
  try {
    await assert.rejects(withFixture('available', false, f => { owned = f.db; }, {close() {}}), /connection.*open/i);
  } finally {
    if (owned?.open) owned.close();
  }
});

test('fixture retains body failure when a close hook leaves connection open', async () => {
  let owned, caught, threw = false;
  try {
    await withFixture('available', false, f => { owned = f.db; throw false; }, {close() {}});
  } catch (error) { threw = true; caught = error; }
  finally { if (owned?.open) owned.close(); }
  assert.equal(threw, true);
  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.errors[0], false);
  assert.match(caught.errors[1].message, /connection.*open/i);
});

test('real initializer preserves falsey initialization and close failures', () => {
  for (const [initialError, cleanupError, closeFirst] of [[false, null, true], [new Error('synthetic initialization'), new Error('synthetic close'), false]]) {
    let owned, closeCalls = 0, caught, threw = false, openAfterFailure;
    class FailingMemoryOnly {
      constructor(path) {
        assert.equal(path, ':memory:');
        assert.equal(owned, undefined);
        owned = new Database(':memory:');
        return new Proxy(owned, {
          get(target, property) {
            if (property === 'prepare') return () => { throw initialError; };
            if (property === 'close') return () => { closeCalls++; if (closeFirst) target.close(); throw cleanupError; };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
    }
    const schema = load(schemaCode, {});
    const client = load(clientCode, {
      'better-sqlite3':{default:FailingMemoryOnly}, '../config/env.js':{env:{DATABASE_URL:'sqlite::memory:'}},
      '../utils/logger.js':{logger:{info(){}}}, './schema.js':schema, '../upstream/siwc-store.js':{},
      'path':{default:{dirname:()=>'.'}}, 'fs':{default:{existsSync:()=>true, mkdirSync:()=>{throw new Error('filesystem denied');}}},
    });
    try {
      try { client.initDatabase(); } catch (error) { threw = true; caught = error; }
      openAfterFailure = owned?.open;
      for (let i = 0; i < 2; i++) {
        assert.throws(() => client.getDb(), /failed|quarantin|closed/i);
        assert.throws(() => client.initDatabase(), /failed|quarantin|closed/i);
        assert.throws(() => client.requireInitializedDatabase(), /not initialized|closed/i);
      }
      if (!closeFirst) {
        let retryThrew = false, retryError;
        try { client.closeDatabase(); } catch (error) { retryThrew = true; retryError = error; }
        assert.equal(retryThrew, true);
        assert.equal(retryError, cleanupError);
        assert.throws(() => client.getDb(), /quarantin/i);
        owned.close(); // Test-owned release permits explicit shutdown, not reinitialization.
      }
      client.closeDatabase();
      client.closeDatabase();
      assert.throws(() => client.getDb(), /closed/i);
      assert.throws(() => client.initDatabase(), /closed/i);
    } finally { if (owned?.open) owned.close(); }
    assert.equal(threw, true);
    assert.equal(openAfterFailure, !closeFirst);
    assert.ok(caught instanceof AggregateError);
    assert.deepEqual(caught.errors, [initialError, cleanupError]);
    assert.equal(closeCalls, closeFirst ? 1 : 2);
    assert.equal(owned.open, false);
  }
});

function lifecycleFixture(fault) {
  const connections = [];
  class MemoryOnly {
    constructor(path) {
      assert.equal(path, ':memory:');
      const db = new Database(':memory:');
      connections.push(db);
      return new Proxy(db, {
        get(target, property) {
          if (property === 'close' && (fault === 'close-before' || fault === 'close-after')) return () => {
            if (fault === 'close-after') target.close();
            throw null;
          };
          if (property === 'prepare' && fault === 'undefined') return () => { throw undefined; };
          if (property === 'pragma' && fault === 'foreign-keys') return (...args) => {
            if (args[0] === 'foreign_keys = ON') throw false;
            return target.pragma(...args);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
  }
  const schema = load(schemaCode, {});
  const store = load(storeCode, {'better-sqlite3':{default:MemoryOnly}, 'node:crypto':require('node:crypto')});
  const client = load(clientCode, {
    'better-sqlite3':{default:MemoryOnly}, '../config/env.js':{env:{DATABASE_URL:'sqlite::memory:'}},
    '../utils/logger.js':{logger:{info(){}}}, './schema.js':schema, '../upstream/siwc-store.js':store,
    'path':{default:{dirname:()=>'.'}}, 'fs':{default:{existsSync:()=>true, mkdirSync:()=>{throw new Error('filesystem denied');}}},
  });
  return {client, connections, cleanup() { for (const db of connections) if (db.open) db.close(); }};
}

for (const [fault, expected] of [['undefined', undefined], ['foreign-keys', false]]) {
  test(`initializer ${fault} failure preserves identity and only retries after confirmed close`, () => {
    const f = lifecycleFixture(fault);
    try {
      for (let i = 0; i < 2; i++) {
        let threw = false, caught;
        try { (i ? f.client.getDb : f.client.initDatabase)(); } catch (error) { threw = true; caught = error; }
        assert.equal(threw, true);
        assert.equal(caught, expected);
        assert.equal(f.connections.length, i + 1);
        assert.equal(f.connections[i].open, false);
        assert.throws(() => f.client.requireInitializedDatabase(), /not initialized|closed/i);
      }
      f.client.closeDatabase(); f.client.closeDatabase();
      assert.throws(() => f.client.getDb(), /closed/i);
      assert.throws(() => f.client.initDatabase(), /closed/i);
      assert.equal(f.connections.length, 2);
    } finally { f.cleanup(); }
  });
}

test('singleton lazy initialization, external close and terminal shutdown', () => {
  const f = lifecycleFixture();
  try {
    assert.throws(() => f.client.requireInitializedDatabase(), /not initialized|closed/i);
    const db = f.client.getDb();
    assert.equal(f.client.initDatabase(), db);
    assert.equal(f.client.requireInitializedDatabase(), db);
    assert.equal(f.connections.length, 1);
    f.connections[0].close();
    assert.throws(() => f.client.getDb(), /closed/i);
    assert.throws(() => f.client.initDatabase(), /closed/i);
    f.client.closeDatabase(); f.client.closeDatabase();
    assert.throws(() => f.client.getDb(), /closed/i);
    assert.equal(f.connections.length, 1);
  } finally { f.cleanup(); }
});

test('successful shutdown closes the lazy singleton without reopening', () => {
  const f = lifecycleFixture();
  try {
    const db = f.client.getDb();
    assert.equal(f.client.getDb(), db);
    f.client.closeDatabase(); f.client.closeDatabase();
    assert.equal(f.connections[0].open, false);
    assert.throws(() => f.client.getDb(), /closed/i);
    assert.throws(() => f.client.initDatabase(), /closed/i);
    assert.equal(f.connections.length, 1);
  } finally { f.cleanup(); }
});

for (const fault of ['close-before', 'close-after']) {
  test(`shutdown ${fault} failure quarantines singleton until confirmed closed`, () => {
    const f = lifecycleFixture(fault);
    try {
      f.client.getDb();
      let threw = false, caught;
      try { f.client.closeDatabase(); } catch (error) { threw = true; caught = error; }
      assert.equal(threw, true); assert.equal(caught, null);
      assert.equal(f.connections[0].open, fault === 'close-before');
      assert.throws(() => f.client.getDb(), /quarantin/i);
      assert.throws(() => f.client.initDatabase(), /quarantin/i);
      if (f.connections[0].open) f.connections[0].close();
      f.client.closeDatabase(); f.client.closeDatabase();
      assert.throws(() => f.client.getDb(), /closed/i);
      assert.equal(f.connections.length, 1);
    } finally { f.cleanup(); }
  });
}

test('simulated setup failure closes the owned connection and retains cleanup failure', () => {
  const setupError = false, cleanupError = new Error('synthetic close failure');
  let owned, caught, threw = false;
  try {
    const unexpected = fixture('available', false, {
      afterOpen(db) { owned = db; throw setupError; },
      close(db) { db.close(); throw cleanupError; },
    });
    unexpected.db.close();
  } catch (error) { threw = true; caught = error; }
  assert.equal(threw, true);
  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(caught.errors, [setupError, cleanupError]);
  assert.equal(owned.open, false);
});

test('simulated pre-snapshot failure and falsey cleanup failure are both retained', async () => {
  let owned, caught, threw = false;
  try {
    await withFixture('available', false, f => {
      owned = f.db;
      throw undefined; // Represents a failure before the first snapshot.
    }, {close(db) { db.close(); throw null; }});
  } catch (error) { threw = true; caught = error; }
  assert.equal(threw, true);
  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(caught.errors, [undefined, null]);
  assert.equal(owned.open, false);
});

for (const mode of ['open','cooldown','exhausted']) {
  test(`SQLite ${mode} publishes only after a committed read-only writer`, async () => {
    await withFixture(mode, false, async f => {
      const before = f.snapshot(), changes = f.totalChanges(); let dispatches=0, signals=0, opened=0, signalled;
      const expected = mode === 'open' ? f.quota.AccountAttemptOpen : mode === 'cooldown' ? f.quota.AccountCooldownBeforeDispatch : f.quota.AccountQuotaExhausted;
      await assert.rejects(f.quota.invokeAccountAttempt(f.account, new AbortController().signal,
        () => { dispatches++; return Promise.resolve({}); }, () => { opened++; },
        () => { assert.equal(mode, 'exhausted'); assert.equal(f.state().completedCommits, 1); assert.equal(f.db.inTransaction, false); signals++; },
        error => { assert.notEqual(mode, 'exhausted'); assert.ok(error instanceof expected); assert.equal(f.state().completedCommits, 1); assert.equal(f.db.inTransaction, false); signalled=error; signals++; }), error => {
          assert.ok(error instanceof expected);
          if (mode !== 'exhausted') assert.equal(error, signalled);
          return true;
        });
      assert.equal(signals,1); assert.equal(dispatches,0); assert.equal(opened,0);
      assert.equal(f.state().operationsCompleted,1); assert.deepEqual(f.snapshot(),before);
      assert.equal(f.totalChanges(),changes, 'even net-zero writes must not occur');
    });
  });
  test(`SQLite ${mode} simulated pre-COMMIT callback failure with same public class publishes no signal`, async () => {
    await withFixture(mode, true, async f => {
      const before = f.snapshot(), changes = f.totalChanges(); let dispatches=0, signals=0, opened=0;
      await assert.rejects(f.quota.invokeAccountAttempt(f.account, new AbortController().signal,
        () => { dispatches++; return Promise.resolve({}); }, () => { opened++; },
        () => { signals++; }, () => { signals++; }), error => error === f.state().injected);
      assert.equal(f.state().operationsCompleted,1); assert.equal(f.state().completedCommits,0);
      assert.equal(f.db.inTransaction,false); assert.equal(signals,0); assert.equal(dispatches,0); assert.equal(opened,0);
      assert.deepEqual(f.snapshot(),before);
      assert.equal(f.totalChanges(), changes, 'even rolled-back writes must not occur');
    });
  });
}

test('SQLite available account reaches the actual dispatch callback', async () => {
  await withFixture('available', false, async f => {
    let dispatches=0, opened=0, signals=0;
    const response = {};
    assert.equal(await f.quota.invokeAccountAttempt(f.account, new AbortController().signal,
      () => { dispatches++; return Promise.resolve(response); }, () => { opened++; },
      () => { signals++; }, () => { signals++; }), response);
    assert.equal(dispatches,1); assert.equal(opened,1); assert.equal(signals,0);
    assert.equal(f.state().completedCommits,2);
    assert.equal(f.snapshot().reservations[0].used,1); assert.equal(f.snapshot().open.length,1);
  });
});

test('audit detects all six operations even when rows return to their original state', async () => {
  await withFixture('available', false, async f => {
    const before = f.snapshot(), changes = f.totalChanges();
    f.db.exec(`INSERT INTO ordinary_account_attempts VALUES ('synthetic','test');
      UPDATE ordinary_account_attempts SET attempt_id=attempt_id;
      DELETE FROM ordinary_account_attempts;
      INSERT INTO account_daily_reservations VALUES ('synthetic','2026-01-01',0,0);
      UPDATE account_daily_reservations SET used=used;
      DELETE FROM account_daily_reservations;`);
    const after = f.snapshot();
    assert.deepEqual(after.open, before.open);
    assert.deepEqual(after.reservations, before.reservations);
    assert.deepEqual(after.audit.map(row => row.operation), [
      'ordinary_account_attempts INSERT', 'ordinary_account_attempts UPDATE', 'ordinary_account_attempts DELETE',
      'account_daily_reservations INSERT', 'account_daily_reservations UPDATE', 'account_daily_reservations DELETE',
    ]);
    assert.ok(f.totalChanges() > changes);
    const beforeRollback = f.snapshot(), rollbackChanges = f.totalChanges();
    assert.throws(() => f.db.transaction(() => {
      f.db.prepare("INSERT INTO ordinary_account_attempts VALUES ('synthetic','rollback')").run();
      throw new Error('synthetic rollback');
    }).immediate(), /synthetic rollback/);
    assert.deepEqual(f.snapshot(), beforeRollback);
    assert.ok(f.totalChanges() > rollbackChanges, 'total_changes also detects rolled-back writes');
  });
});

test('already aborted request never acquires its writer', async () => {
  await withFixture('available', false, async f => {
    const controller = new AbortController(), reason = new Error('synthetic abort');
    const before = f.snapshot(), changes = f.totalChanges();
    controller.abort(reason);
    await assert.rejects(f.quota.invokeAccountAttempt(f.account, controller.signal, () => { throw new Error('unexpected dispatch'); }), error => error === reason);
    assert.equal(f.state().completedCommits, 0);
    assert.equal(f.state().operationsCompleted, 0);
    assert.equal(f.totalChanges(), changes);
    assert.deepEqual(f.snapshot(), before);
  });
});

test('abort after reservation commit prevents dispatch and closes the owned open', async () => {
  await withFixture('available', false, async f => {
    const controller = new AbortController(), reason = new Error('synthetic abort');
    let opened = 0, dispatches = 0;
    await assert.rejects(f.quota.invokeAccountAttempt(f.account, controller.signal,
      () => { dispatches++; return Promise.resolve({}); }, () => {
        opened++;
        assert.equal(f.state().completedCommits, 1);
        assert.equal(f.db.inTransaction, false);
        controller.abort(reason);
      }), error => error === reason);
    assert.equal(opened, 1);
    assert.equal(dispatches, 0);
    assert.equal(f.state().completedCommits, 2);
    assert.equal(f.snapshot().open.length, 0);
    assert.equal(f.snapshot().reservations[0].used, 1);
  });
});
