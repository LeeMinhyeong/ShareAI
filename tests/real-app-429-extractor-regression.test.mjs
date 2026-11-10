import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { extractFixture429 } from './fixtures/real-app-429-extractor.mjs';
import { scenario } from './fixtures/real-app-429-scenario.mjs';
import { cleanupFixture } from './fixtures/real-app-429-cleanup.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scenario preserves falsy primary and rollback failures', () => {
  const cleanup = new Error('rollback failed');
  for (const phase of ['ROLLBACK', 'RELEASE']) {
    const fake = { exec: sql => { if (sql.startsWith(phase)) throw cleanup; } };
    for (const primary of [undefined, null, false, 0]) {
      assert.throws(() => scenario(fake, () => { throw primary; }, () => {}), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      });
    }
    assert.throws(() => scenario(fake, () => {}, () => 1), error => error === cleanup);
  }
});

test('scenario rolls back real SQLite changes on success and failure', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE sample (value INTEGER)');
    const setup = () => db.exec('INSERT INTO sample VALUES (1)');
    assert.equal(scenario(db, setup, () => 42), 42);
    const primary = new Error('check');
    assert.throws(() => scenario(db, setup, () => { throw primary; }), error => error === primary);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sample').get().n, 0);
  } finally { db.close(); }
});

test('fixture retention and failure preservation when cwd restoration fails', () => {
  const cwdError = new Error('cwd failed');
  let removed = false, closed = false;
  assert.throws(() => cleanupFixture({
    close:() => { closed = true; }, restore:() => { throw cwdError; },
    remove:() => { removed = true; }, dir:'synthetic', failed:true, primary:false,
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], false);
    assert.equal(error.errors[1], cwdError);
    assert.match(error.errors[2].message, /Fixture retained/);
    return true;
  });
  assert.equal(closed, true);
  assert.equal(removed, false);
});

const canonical = `CREATE TABLE account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`;

test('extractor holds one snapshot across concurrent schema and row commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-429-snapshot-'));
  const path = join(dir, 'fixture.sqlite');
  const ready = join(dir, 'ready'), release = join(dir, 'release'), committed = join(dir, 'committed');
  let db, child, closed = false;
  try {
    db = new Database(path);
    assert.equal(db.pragma('journal_mode = WAL', {simple:true}).toLowerCase(), 'wal');
    db.exec(canonical);
    db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('siwc', 'baseline', 1, 2, 1);
    const script = `
      const Database = require('better-sqlite3');
      const fs = require('node:fs');
      const [path, ready, release, committed] = process.argv.slice(1);
      const db = new Database(path, {fileMustExist:true});
      try {
        fs.writeFileSync(ready, 'ready');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(release)) {
          if (Date.now() > deadline) throw Error('reader barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        db.transaction(() => {
          db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('siwc', 'new-row', 3, 4, 1);
          db.exec('CREATE INDEX concurrent_extra ON account_429_cooldowns(revision)');
        })();
        fs.writeFileSync(committed, 'committed');
      } finally { db.close(); }
    `;
    child = spawn(process.execPath, ['-e', script, path, ready, release, committed], {cwd:process.cwd(), stdio:['ignore','ignore','pipe']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    const close = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({code, signal}); }));
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) {
      if (spawnError) throw spawnError;
      if (closed || Date.now() > deadline) throw new Error(`writer failed to become ready: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const prepare = db.prepare.bind(db);
    let barrierReached = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (!/SELECT\s+type\s*,\s*name/i.test(sql)) return statement;
      return new Proxy(statement, {get(target, prop) {
        if (prop === 'all') return (...args) => {
          const result = target.all(...args); // actual schema read establishes the SQLite snapshot
          barrierReached = true;
          writeFileSync(release, 'release');
          const until = Date.now() + 10000;
          while (!existsSync(committed)) {
            if (Date.now() > until) throw new Error('writer commit barrier timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          return result;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    const result = extractFixture429(db);
    assert.equal(barrierReached, true);
    assert.deepEqual(result.extractionCounts, {counted:1, iterated:1, planned:1});
    assert.deepEqual(result.cooldowns, [{kind:'siwc', account_id:'baseline', observed_at:1, until_at:2, revision:1}]);
    db.prepare = prepare;
    let exitTimer;
    const exit = await Promise.race([close, new Promise(resolve => { exitTimer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(exitTimer);
    assert.deepEqual(exit, {code:0, signal:null}, stderr || 'writer close timed out');
    assert.throws(() => extractFixture429(db), /Unsafe 429 snapshot/); // fresh snapshot sees the new index
    db.exec('DROP INDEX concurrent_extra');
    const fresh = extractFixture429(db);
    assert.deepEqual(fresh.extractionCounts, {counted:2, iterated:2, planned:2});
    assert.deepEqual(fresh.cooldowns.map(row => row.account_id), ['baseline', 'new-row']);
  } finally {
    if (child && !closed) {
      const close = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
      child.kill();
      let timer;
      await Promise.race([close, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
    }
    if (db) db.close();
    if (!child || closed) rmSync(dir, {recursive:true, force:true});
    else throw new Error(`writer close unconfirmed; fixture retained at ${dir}, pid ${child.pid}`);
  }
});

test('rejects UTF-16 while accepting the same schema and rows in UTF-8', t => {
  const utf8 = new Database(':memory:');
  const utf16 = new Database(':memory:');
  try {
    utf16.pragma("encoding = 'UTF-16le'");
    const row = {kind:'siwc', account_id:'baseline', observed_at:1, until_at:2, revision:1};
    for (const db of [utf8, utf16]) {
      db.exec(canonical);
      db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)')
        .run(row.kind, row.account_id, row.observed_at, row.until_at, row.revision);
    }
    assert.equal(utf8.pragma('main.encoding', {simple:true}), 'UTF-8');
    const encoding = utf16.pragma('main.encoding', {simple:true});
    if (encoding !== 'UTF-16le') return t.skip(`SQLite did not create UTF-16le database (reported ${encoding})`);
    for (const db of [utf8, utf16]) {
      assert.equal(db.prepare("SELECT sql FROM sqlite_schema WHERE name='account_429_cooldowns'").get().sql, canonical);
      assert.deepEqual(db.prepare('SELECT * FROM account_429_cooldowns').all(), [row]);
    }
    const result = extractFixture429(utf8);
    assert.deepEqual(result.cooldowns, [row]);
    assert.deepEqual(result.extractionCounts, {counted:1, iterated:1, planned:1});

    // The extractor exposes only a generic unsafe error. Ensure it consulted
    // encoding and rejected before any schema/row query could cause that error.
    const pragma = utf16.pragma.bind(utf16);
    let encodingChecked = false;
    utf16.pragma = (name, options) => {
      if (name === 'main.encoding') encodingChecked = true;
      return pragma(name, options);
    };
    utf16.prepare = () => { throw new Error('query reached before encoding rejection'); };
    assert.throws(() => extractFixture429(utf16), /^Error: Unsafe 429 snapshot$/);
    assert.equal(encodingChecked, true);
  } finally { utf8.close(); utf16.close(); }
});

test('accepts row and UTF-8 byte boundaries and safe integer endpoints', () => {
  const db = new Database(':memory:');
  try {
    db.exec(canonical);
    const insert = db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)');
    for (let i = 0; i < 1023; i++) insert.run('siwc', `id-${i}`, 1, 2, 1);
    const id = 'é'.repeat(256);
    insert.run('upstream', id, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const result = extractFixture429(db);
    assert.deepEqual(result.extractionCounts, {counted:1024, iterated:1024, planned:1024});
    assert.deepEqual(result.cooldowns.find(row => row.account_id === id), {
      kind:'upstream', account_id:id, observed_at:Number.MIN_SAFE_INTEGER,
      until_at:Number.MAX_SAFE_INTEGER, revision:Number.MAX_SAFE_INTEGER,
    });
    insert.run('siwc', 'one-too-many', 1, 2, 1);
    assert.throws(() => extractFixture429(db), /Unsafe 429 snapshot/);
  } finally { db.close(); }
});

test('rejects extra explicit indexes and temporary triggers', () => {
  for (const setup of [
    'CREATE INDEX extra_429 ON account_429_cooldowns(revision)',
    'CREATE TEMP TRIGGER extra_429 AFTER INSERT ON main.account_429_cooldowns BEGIN SELECT 1; END',
  ]) {
    const db = new Database(':memory:');
    try {
      db.exec(canonical); db.exec(setup);
      assert.throws(() => extractFixture429(db), /Unsafe 429 snapshot/);
    } finally { db.close(); }
  }
});

test('close failure retains fixture independently', () => {
  const failure = new Error('close');
  let removed = false, restored = false;
  assert.throws(() => cleanupFixture({ close:() => { throw failure; },
    restore:() => { restored = true; }, remove:() => { removed = true; },
    dir:'synthetic', failed:false,
  }), error => error instanceof AggregateError && error.errors[0] === failure && /Fixture retained/.test(error.errors[1].message));
  assert.equal(restored, true);
  assert.equal(removed, false);
});

test('rejects frozen SQL that disagrees with loaded column metadata', () => {
  const db = new Database(':memory:');
  try {
    db.exec(canonical.replace('observed_at INTEGER NOT NULL', 'observed_at TEXT NOT NULL'));
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE name='account_429_cooldowns'").run(canonical);
    db.pragma('writable_schema = OFF');
    assert.equal(db.prepare('PRAGMA table_xinfo(account_429_cooldowns)').all()[2].type, 'TEXT');
    assert.throws(() => extractFixture429(db), /Unsafe 429 snapshot/);
  } finally { db.close(); }
});

test('oversized schema SQL is rejected without crossing into JS', () => {
  const db = new Database(':memory:');
  try {
    db.exec(canonical);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE name='account_429_cooldowns'").run(canonical + ' '.repeat(100000));
    db.pragma('writable_schema = OFF');
    const original = db.prepare.bind(db);
    let observed = false;
    db.prepare = sql => {
      const statement = original(sql);
      if (!/SELECT\s+type\s*,\s*name/i.test(sql)) return statement;
      observed = true;
      return new Proxy(statement, {get(target, prop) {
        if (prop === 'get' || prop === 'all') return (...args) => {
          const result = target[prop](...args);
          for (const row of Array.isArray(result) ? result : [result]) {
            assert.ok(row?.sql == null || Buffer.byteLength(row.sql) <= 4096, 'oversized SQL crossed into JS');
          }
          return result;
        };
        return Reflect.get(target, prop, target);
      }});
    };
    assert.throws(() => extractFixture429(db), /Unsafe 429 snapshot/);
    assert.equal(observed, true);
  } finally { db.close(); }
});

test('loaded extra indexes are rejected using bounded iteration', () => {
  const db = new Database(':memory:');
  try {
    db.exec(canonical + '; CREATE INDEX synthetic_extra ON account_429_cooldowns(revision)');
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.exec("DELETE FROM sqlite_schema WHERE name='synthetic_extra'");
    db.pragma('writable_schema = OFF');
    assert.equal(db.prepare('PRAGMA index_list(account_429_cooldowns)').all().length, 2);
    const original = db.prepare.bind(db);
    db.prepare = sql => {
      const statement = original(sql);
      if (!/PRAGMA main.index_list/i.test(sql)) return statement;
      return new Proxy(statement, {get(target, prop) {
        if (prop === 'all') throw new Error('unbounded index enumeration');
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    assert.throws(() => extractFixture429(db), /Unsafe 429 snapshot/);
  } finally { db.close(); }
});
