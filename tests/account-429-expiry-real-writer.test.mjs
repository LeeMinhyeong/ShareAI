import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Offline, single-host fixture; these checks do not defend against concurrent
// replacement of the database path or its ancestor directories.
const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), '..');

if (process.argv[2] === '--owned-child') {
  const { createRequire } = await import('node:module');
  const vm = await import('node:vm');
  const require = createRequire(path.join(repo, 'package.json'));
  const ts = require('typescript');
  const Database = require('better-sqlite3');
  const dir = process.cwd();
  const root = process.argv[3];
  assert.ok(root && path.isAbsolute(root) && path.dirname(dir) === path.resolve(root));
  assert.ok(path.basename(dir).startsWith('expiry-real-writer-'));
  assert.ok(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink());
  assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir, 'owned-marker'), 'utf8'), 'expiry real writer fixture');
  const dbPath = path.join(dir, 'fixture.sqlite');
  let shared, other, service;
  const writers = [];
  let runtime;
  let calls = 0, callbacks = 0, switched = false, switchError;
  const callbacksSeen = [];
  const WriterDatabase = new Proxy(Database, { construct(target, args) {
    assert.equal(args[0], dbPath);
    const db = Reflect.construct(target, args);
    writers.push(db);
    return db;
  }});
  const client = {
    getDb: () => runtime,
    requireInitializedDatabase: () => {
      if (!runtime || !runtime.open) throw new Error('Database is not initialized or is closed');
      return runtime;
    },
  };
  const sandbox = vm.createContext({ AbortController, performance, setTimeout, clearTimeout, console: Object.freeze({}) });
  function load(name, deps) {
    const source = fs.readFileSync(path.join(repo, 'src', 'db', name + '.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    const resolve = id => { if (!Object.hasOwn(deps, id)) throw new Error('Unexpected dependency'); return deps[id]; };
    new vm.Script('(function(exports,require,module){"use strict";\n' + code + '\n})', { filename: name + '.js' }).runInContext(sandbox)(module.exports, resolve, module);
    return module.exports;
  }
  let failure;
  try {
    shared = new Database(dbPath);
    runtime = shared;
    const store = load('account-429-v2-store', {});
    shared.transaction(() => { store.provision429V2(shared); store.arm429V2(shared, 'upstream', 'target', 100); store.arm429V2(shared, 'siwc', 'keep', null); }).immediate();
    const writer = load('async-writer', { 'better-sqlite3': WriterDatabase, './client.js': client, '../utils/logger.js': {logger: {error() { throw new Error('writer cleanup error'); }}} });
    const instrumented = { withAsyncWriter(callback, options) {
      calls++;
      callbacksSeen.push(callback);
      return writer.withAsyncWriter(db => {
        callbacks++;
        assert.notEqual(db, shared);
        assert.equal(db.name, shared.name);
        if (switched) runtime = other;
        try { return callback(db); }
        catch (error) { if (switched) switchError = error; throw error; }
      }, options);
    }};
    const { Account429V2Expiry } = load('account-429-v2-expiry', { './client.js': client, './async-writer.js': instrumented, './account-429-v2-store.js': store });
    let now = 0n;
    const failures = [];
    const makeService = () => new Account429V2Expiry({onFailure: error => { failures.push(error.message); }, monotonic: () => now, setTimer: () => {throw new Error('unexpected timer');}, clearTimer: () => {}, intervalMs: 10, maxObservations: 8, scanBatch: 8});
    const rows = () => shared.prepare('SELECT kind, account_id, generation, duration_ms FROM account_429_v2_restrictions ORDER BY kind, account_id').all();
    const initial = rows();
    service = makeService();
    let flight = service.tick(); await flight;
    assert.deepEqual(rows(), initial);
    now = 99000000n; flight = service.tick(); await flight;
    assert.deepEqual(rows(), initial);
    now = 100000000n; flight = service.tick(); await flight;
    assert.deepEqual(rows(), initial.filter(row => row.account_id !== 'target'));
    assert.equal(calls, 3); assert.equal(callbacks, 3); assert.equal(callbacksSeen.length, 3);
    assert.equal(shared.open, true);
    assert.equal(runtime, shared);
    await service.stopAndDrain(); service = undefined;
    assert.deepEqual(failures, []);
    shared.transaction(() => store.arm429V2(shared, 'upstream', 'target', 1)).immediate();
    const beforeSwitch = rows();
    other = new Database(dbPath);
    service = makeService();
    now = 200000000n; await service.tick();
    assert.deepEqual(failures, []);
    now = 201000000n; switched = true;
    await assert.rejects(service.tick(), {message: 'Expiry tick failed'});
    assert.deepEqual(failures, ['Expiry tick failed']);
    assert.equal(switchError?.message, 'Expiry database changed');
    switched = false; runtime = shared;
    assert.deepEqual(rows(), beforeSwitch);
    assert.equal(calls, 5); assert.equal(callbacks, 5);
    assert.equal(shared.open, true);
    try { await service.stopAndDrain(); assert.fail('failed service drain should reject'); } catch (e) { assert.equal(e.message, 'Expiry service failed'); }
    assert.deepEqual(failures, ['Expiry tick failed']);
    service = undefined;
    assert.equal(writers.length, 5);
    assert.ok(writers.every(db => db.open === false));
    writer.retryQuarantinedWriters();
  } catch (e) { failure = e; }
  finally {
    if (service) { try { await service.stopAndDrain(); } catch {} }
    try { if (other?.open) other.close(); } catch { failure ||= new Error('fixture close failed'); }
    try { if (shared?.open) shared.close(); } catch { failure ||= new Error('fixture close failed'); }
    if (other?.open || shared?.open || writers.some(db => db.open !== false)) failure ||= new Error('fixture handle closure unconfirmed');
  }
  if (failure) { console.error('OWNED_CHILD_FAILED'); process.exitCode = 1; }
  else console.log('PRODUCTION_FILE_WRITER_INVOKED_5_CLOSED_5');
} else {
  test('expiry uses the actual file writer and rejects singleton switches', {timeout: 20000}, async () => {
    const root = process.env.TMPDIR;
    assert.ok(root && path.isAbsolute(root), 'explicit absolute TMPDIR required');
    const st = fs.lstatSync(root);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'TMPDIR must be a directory, not a symlink');
    const dir = fs.mkdtempSync(path.join(root, 'expiry-real-writer-'));
    assert.ok(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink());
    fs.writeFileSync(path.join(dir, 'owned-marker'), 'expiry real writer fixture', {flag: 'wx'});
    let closed = false, verifiedHandlesClosed = false, child;
    try {
      child = spawn(process.execPath, [self, '--owned-child', root], {cwd: dir, env: {}, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '', oversized = false, timedOut = false;
      const collect = chunk => { if (output.length + chunk.length > 8192) { oversized = true; child.kill(); } else output += chunk.toString(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', () => {}); child.stdout.on('error', () => {}); child.stderr.on('error', () => {});
      const result = await new Promise(resolve => {
        const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
        const ceiling = setTimeout(() => resolve(null), 15000);
        child.on('close', (code, signal) => { closed = true; clearTimeout(deadline); clearTimeout(ceiling); resolve({code, signal}); });
      });
      assert.ok(closed && result, 'owned child close unconfirmed; fixture preserved');
      assert.equal(timedOut, false, 'owned child timed out');
      assert.equal(oversized, false, 'owned child output exceeded limit');
      assert.equal(result.code, 0, 'owned child failed');
      assert.equal(result.signal, null, 'owned child signalled');
      assert.ok(output.includes('PRODUCTION_FILE_WRITER_INVOKED_5_CLOSED_5'), 'real writer marker missing');
      verifiedHandlesClosed = true;
    } finally {
      if (closed && verifiedHandlesClosed) fs.rmSync(dir, {recursive: true, force: true});
    }
  });
}
