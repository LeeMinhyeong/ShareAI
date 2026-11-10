import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire, registerHooks} from 'node:module';
import {mkdtempSync, renameSync, rmSync, existsSync, lstatSync, realpathSync, readdirSync} from 'node:fs';
import {join, resolve, parse, dirname, basename} from 'node:path';
import {userInfo} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function checkChain(path) {
  const full = resolve(path);
  let current = parse(full).root;
  for (const part of full.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink() || !samePath(realpathSync(current), current)) throw new Error('unsafe writer fixture');
  }
  return full;
}
function scratchRoot() {
  // Do not derive this boundary from TMPDIR or an inherited LOCALAPPDATA.
  return checkChain(join(userInfo().homedir, 'AppData', 'Local', 'hermes', 'cache', 'scratch'));
}
function validateChild(mode) {
  try {
    if (!/^(pragma-[12]-(normal|throws)|file-(success|abort)|memory-(success|abort))$/.test(mode) || process.env.NODE_ENV !== 'test') throw 0;
    const root = scratchRoot();
    const dir = checkChain(process.cwd());
    if (!samePath(dirname(dir), root) || !/^writer-startup-[A-Za-z0-9]{6}$/.test(basename(dir))) throw 0;
    if (process.env.TMPDIR !== dir || process.env.TEMP !== dir || process.env.TMP !== dir) throw 0;
    const expected = mode.startsWith('memory') ? 'sqlite::memory:' : `sqlite:${join(dir, 'fixture.sqlite')}`;
    if (process.env.DATABASE_URL !== expected || readdirSync(dir).length !== 0) throw 0;
  } catch { throw new Error('unsafe writer fixture'); }
}

// A failed kill is not proof of exit. Resolve only after close, or preserve evidence.
export function waitForChild(child, {deadline = 15000, grace = 5000} = {}) {
  return new Promise(resolve => {
    let settled = false, killTimer, killError;
    const timer = setTimeout(() => {
      try {
        if (!child.kill()) killError = 'kill returned false';
      } catch { killError = 'kill threw'; }
      killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.unref(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        resolve({closed: false, pid: child.pid, killError});
      }, grace);
    }, deadline);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({closed: true, code, signal, pid: child.pid, killError});
    });
  });
}

// Each child owns its singleton. Preserve fixtures if child closure is unconfirmed.
async function runCase(mode) {
  const scratch = scratchRoot();
  const dir = mkdtempSync(join(scratch, 'writer-startup-'));
  checkChain(dir);
  const file = join(dir, 'fixture.sqlite');
  let closed = false;
  try {
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: dir, TMP: dir, TMPDIR: dir,
      DATABASE_URL: `sqlite:${mode.startsWith('memory') ? ':memory:' : file}`,
      ENCRYPTION_KEY: '0'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20),
      NODE_ENV: 'test', LOG_LEVEL: 'error', WRITER_TEST_CASE: mode,
    };
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url)], {
      cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childError;
    child.on('error', error => { childError = error; });
    child.stderr.on('error', error => { childError = error; });
    child.stderr.resume(); // Do not expose paths or synthetic environment.
    const result = await waitForChild(child);
    closed = result.closed;
    assert.ok(closed, `child close unconfirmed; pid=${result.pid}; ${result.killError ?? 'kill sent'}; fixture preserved: ${dir}`);
    assert.equal(childError, undefined, 'child or stderr error');
    assert.equal(result.signal, null, 'child was terminated');
    assert.equal(result.code, 0, 'child assertion failed');
    if (!mode.startsWith('memory')) {
      const renamed = join(dir, 'renamed.sqlite');
      renameSync(file, renamed);
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(renamed), true);
      rmSync(renamed);
      assert.equal(existsSync(renamed), false);
    }
  } finally {
    if (closed) rmSync(dir, {recursive: true, force: true});
  }
}

async function childCase(mode) {
  const require = createRequire(import.meta.url);
  const RealDatabase = require('better-sqlite3');
  const injected = new Error('synthetic PRAGMA failure');
  const closeError = new Error('synthetic close failure');
  const match = /^pragma-([12])-(normal|throws)$/.exec(mode);
  let writer, originalClose, writerCount = 0, closeCalls = 0;
  const pragmas = [], statements = [];
  function TestDatabase(path, options) {
    writerCount++;
    const db = new RealDatabase(path, options);
    writer = db;
    const pragma = db.pragma.bind(db), exec = db.exec.bind(db);
    originalClose = db.close.bind(db);
    db.pragma = (sql, ...args) => {
      pragmas.push(sql);
      if (match && pragmas.length === Number(match[1])) throw injected;
      return pragma(sql, ...args);
    };
    db.exec = sql => { statements.push(sql); return exec(sql); };
    db.close = () => {
      closeCalls++;
      originalClose(); // The simulated close failure still releases the handle.
      if (match?.[2] === 'throws') throw closeError;
    };
    return db;
  }
  globalThis.__writerTestDatabase = TestDatabase;
  const hooks = registerHooks({resolve(specifier, context, nextResolve) {
    if (specifier === 'better-sqlite3' && context.parentURL?.includes('/db/async-writer.ts')) {
      return {url: 'data:text/javascript,export default globalThis.__writerTestDatabase', shortCircuit: true};
    }
    return nextResolve(specifier, context);
  }});
  // The production client never creates a database (ADR 0018): provision the validated, empty fixture dir.
  await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
  const {getDb, closeDatabase} = await import('../src/db/client.ts');
  const {withAsyncWriter} = await import('../src/db/async-writer.ts');
  let shared;
  try {
    shared = getDb();
    shared.exec('CREATE TABLE writer_probe (n INTEGER NOT NULL)');
    let calls = 0;
    if (match) {
      assert.throws(() => withAsyncWriter(() => { calls++; }), error => match[2] === 'throws'
        ? error instanceof AggregateError && error.errors[0] === injected && error.message === 'Writer and cleanup failed' && error.errors.length === 2 && error.errors[1] instanceof Error && error.errors[1].message === 'Writer cleanup failed' && !('cause' in error.errors[1]) && !require('node:util').inspect(error, {depth: Infinity}).includes('synthetic close failure') // close details must not leak (db-lifecycle-reentrancy-memory)
        : error === injected);
      assert.equal(writerCount, 1);
      assert.equal(closeCalls, 1);
      assert.equal(writer.open, false);
      assert.equal(pragmas.length, Number(match[1]));
      assert.deepEqual(statements, []);
      assert.equal(calls, 0);
    } else if (mode.endsWith('abort')) {
      const controller = new AbortController();
      const reason = new Error('synthetic abort');
      controller.abort(reason);
      assert.throws(() => withAsyncWriter(() => { calls++; }, {signal: controller.signal}), error => error === reason);
      assert.equal(calls, 0);
      // File cancellation opens and closes a writer; memory opens no second DB.
      assert.equal(writerCount, mode === 'memory-abort' ? 0 : 1);
      assert.equal(closeCalls, writerCount);
      if (writer) assert.equal(writer.open, false);
    } else {
      const result = withAsyncWriter(db => { calls++; db.exec('INSERT INTO writer_probe VALUES (2)'); return 42; });
      assert.equal(result, 42);
      assert.equal(calls, 1);
      assert.equal(writerCount, mode === 'memory-success' ? 0 : 1);
      assert.equal(closeCalls, writerCount);
      assert.equal(shared.prepare('SELECT COUNT(*) AS n FROM writer_probe').get().n, 1);
    }
    assert.equal(shared.open, true);
    if (match || mode.endsWith('abort')) assert.equal(shared.prepare('SELECT COUNT(*) AS n FROM writer_probe').get().n, 0);
  } finally {
    if (writer?.open) originalClose();
    if (shared?.open) closeDatabase();
    hooks.deregister();
    delete globalThis.__writerTestDatabase;
  }
}

if (process.env.WRITER_TEST_CASE) {
  validateChild(process.env.WRITER_TEST_CASE);
  await childCase(process.env.WRITER_TEST_CASE);
} else {
  for (const at of [1, 2]) {
    for (const closeMode of ['normal', 'throws']) {
      test(`PRAGMA ${at} failure preserves the error when close ${closeMode}`, () => runCase(`pragma-${at}-${closeMode}`));
    }
  }
  // In-memory SQLite is unsupported (ADR 0018), so only the file writer path is exercised.
  for (const mode of ['file-success', 'file-abort']) {
    test(mode, () => runCase(mode));
  }
}
