import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

// This isolated integration test is intentionally specific to this Windows
// workspace, not a reusable scratch locator. Only non-Windows hosts skip;
// Windows users on other accounts fail if the pinned path is unavailable;
// porting it requires an explicitly reviewed, fixed local scratch root. Neither
// HOME/USERPROFILE nor TMPDIR can nominate the worker's approved root.
// This protects against accidental misconfiguration, not hostile local users:
// hard links, filesystem replacement races, and trusted-path tampering remain.
const approvedScratch = () => {
  assert.equal(process.platform, 'win32', 'fixture validation: unsupported host; configure a reviewed scratch root');
  return realpathSync('C:/Users/Administrator/AppData/Local/hermes/cache/scratch');
};
function scratchUnavailable(platform = process.platform, isDirectory = () => lstatSync(approvedScratch()).isDirectory()) {
  if (platform !== 'win32') return 'requires the reviewed Windows scratch workspace';
  assert.ok(isDirectory(), 'reviewed scratch workspace is not a directory');
  return false;
}
const scratchTest = (name, fn) => test(name, {skip:scratchUnavailable()}, fn);

async function cleanupScheduler(scheduler, closeDatabase) {
  let stopError, stopFailed = false;
  try {
    if (scheduler) await scheduler.stop(); // Its completion waits for both tick and coordinator stop.
  } catch (error) {
    stopFailed = true; stopError = error;
  } finally {
    try { closeDatabase(); }
    catch (error) {
      if (stopFailed) throw new AggregateError([stopError, error], 'Scheduler and database cleanup failed');
      throw error;
    }
  }
  if (stopFailed) throw stopError;
}

// This file is also its own isolated worker. Neither worker reads the repo's
// environment or database: cwd, environment and DATABASE_URL are synthetic.
const phase = process.argv[2];
if (phase === 'seed' || phase === 'reopen') {
  // Accidental-misconfiguration guard only: hard links and filesystem replacement
  // races cannot be excluded; this is not an adversarial security boundary.
  // Validate parent-supplied arguments and marker before importing application config.
  const [scratch, dir, dbPath, token] = process.argv.slice(3);
  assert.equal(process.argv.length, 7, 'fixture validation: worker requires parent fixture arguments');
  assert.ok([scratch, dir, dbPath].every(p => typeof p === 'string' && isAbsolute(p)), 'fixture validation: absolute paths required');
  assert.match(token, /^[a-f0-9]{64}$/, 'fixture validation: invalid owner token');
  assert.equal(scratch, approvedScratch(), 'fixture validation: unapproved scratch root');
  assert.equal(realpathSync(dir), dir, 'fixture validation: fixture directory must be canonical');
  assert.equal(dirname(dir), scratch, 'fixture validation: fixture directory must be a direct child');
  assert.match(basename(dir), /^scheduler-coordinator-[A-Za-z0-9]+$/);
  assert.equal(realpathSync(process.cwd()), dir);
  assert.equal(dbPath, join(dir, 'fixture.sqlite'), 'fixture validation: invalid database path');
  assert.equal(process.env.DATABASE_URL, `sqlite:${dbPath}`);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.ENCRYPTION_KEY, 'a'.repeat(64));
  assert.equal(process.env.ADMIN_API_KEY, 'x'.repeat(20));
  const marker = join(dir, 'fixture-owner.txt');
  assert.ok(lstatSync(marker).isFile(), 'fixture validation: owner marker must be a regular file');
  assert.equal(readFileSync(marker, 'utf8'), token, 'fixture validation: owner marker mismatch');
  let dbStat;
  try { dbStat = lstatSync(dbPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (dbStat) assert.ok(dbStat.isFile(), 'fixture validation: database must be a regular file, not a link');
  assert.equal(Boolean(dbStat), phase === 'reopen', 'fixture validation: unexpected database presence');
  const {getDb, closeDatabase} = await import('../src/db/client.ts');
  const {settleAppAttempt} = await import('../src/db/experimental-atomic-429-app.ts');
  const {CooldownCoordinator} = await import('../src/db/experimental-429-coordinator.ts');
  const {Experimental429Scheduler} = await import('../src/db/experimental-429-scheduler.ts');
  const db = getDb();
  let scheduler, primaryError, primaryFailed = false;
  try {
    assert.equal(db.name, join(process.cwd(), 'fixture.sqlite'));
    if (phase === 'seed') {
      db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);
INSERT INTO ordinary_account_attempts VALUES ('same-id','up-owner');
INSERT INTO siwc_account_attempts VALUES ('same-id','siwc-owner');`);
      assert.equal(await settleAppAttempt({kind:'upstream', accountId:'same-id', attemptId:'up-owner', durationNs:10000000n}), 1n);
      assert.equal(await settleAppAttempt({kind:'siwc', accountId:'same-id', attemptId:'siwc-owner', durationNs:10000000n}), 2n);
    }
    const rows = () => db.prepare('SELECT kind,account_id,generation,duration_ns FROM experimental_atomic_429_restrictions ORDER BY kind').safeIntegers().all();
    const expected = [
      {kind:'siwc', account_id:'same-id', generation:2n, duration_ns:10000000n},
      {kind:'upstream', account_id:'same-id', generation:1n, duration_ns:10000000n},
    ];
    assert.deepEqual(rows(), expected);
    let time = phase === 'seed' ? 0 : 100;
    let next = 0;
    const pending = new Map();
    const timers = {
      now: () => time,
      setTimeout(fn, ms) { const id = ++next; pending.set(id, {fn, ms}); return id; },
      clearTimeout(id) { pending.delete(id); },
      fire() {
        assert.equal(pending.size, 1);
        const [id, task] = pending.entries().next().value;
        pending.delete(id); time += task.ms; task.fn();
      },
    };
    const coordinator = new CooldownCoordinator({capacity:2, pageSize:2, clock:() => BigInt(time) * 1000000n});
    const tick = coordinator.tick.bind(coordinator);
    let calls = 0, active = 0, maxActive = 0;
    coordinator.tick = async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try { return await tick(); } finally { active--; }
    };
    scheduler = new Experimental429Scheduler(coordinator, {timers, intervalMs:1, maxAttempts:20, lifetimeMs:1000, backoffMs:1, maxBackoffMs:1});
    // Construction alone is opt-in and must not start ticks or arm timers.
    for (let i=0; i<30; i++) await Promise.resolve();
    assert.equal(calls, 0); assert.equal(pending.size, 0); assert.deepEqual(rows(), expected);
    const done = scheduler.start();
    const waitForTimer = async () => {
      for (let i=0; i<300 && pending.size === 0; i++) await Promise.resolve();
      assert.equal(pending.size, 1, 'one serial timer follows a completed tick');
      assert.equal(active, 0);
    };
    await waitForTimer();
    assert.equal(calls, 1); assert.deepEqual(rows(), expected);
    for (let elapsed=1; elapsed<=9; elapsed++) {
      timers.fire(); await waitForTimer();
      assert.equal(calls, elapsed + 1);
      assert.deepEqual(rows(), expected, `${elapsed} ms is less than the full observation`);
    }
    if (phase === 'reopen') {
      // Expiry is permitted at the exact full post-restart observation.
      timers.fire(); await waitForTimer();
      assert.equal(calls, 11); assert.deepEqual(rows(), [], 'both colliding IDs expire after a fresh full observation');
    }
    await scheduler.stop(); await done;
    assert.equal(pending.size, 0); assert.equal(maxActive, 1);
    await assert.rejects(coordinator.tick(), /Coordinator stopped/);
    if (phase === 'seed') assert.deepEqual(rows(), expected);
  } catch (error) {
    primaryFailed = true; primaryError = error;
  } finally {
    try { await cleanupScheduler(scheduler, closeDatabase); }
    catch (error) {
      if (primaryFailed && error !== primaryError) throw new AggregateError([primaryError, error], 'Worker and cleanup failed');
      throw error;
    }
  }
  if (primaryFailed) throw primaryError;
} else {
  test('scratch availability skips only unsupported platforms and surfaces workspace errors', () => {
    assert.match(scratchUnavailable('linux', () => { throw new Error('must not probe'); }), /requires/);
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
      const error = Object.assign(new Error(code), {code});
      assert.throws(() => scratchUnavailable('win32', () => { throw error; }), e => e === error);
    }
    assert.throws(() => scratchUnavailable('win32', () => false), /not a directory/);
    assert.equal(scratchUnavailable('win32', () => true), false);
  });
  test('cleanup closes after a settled scheduler stop rejects', async () => {
    const failure = new Error('injected stop failure');
    let release;
    let closed = false;
    const stopped = new Promise((_, reject) => { release = () => reject(failure); });
    const cleanup = cleanupScheduler({stop:() => stopped}, () => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, 'database remains open while stop is pending');
    release();
    await assert.rejects(cleanup, error => error === failure);
    assert.equal(closed, true, 'database closes after rejected stop settles');
  });
  scratchTest('direct worker without parent fixture refuses before creating a database', () => {
    const scratch = approvedScratch();
    const dir = mkdtempSync(join(scratch, 'scheduler-direct-'));
    const db = join(dir, 'fixture.sqlite');
    try {
      const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch,
        NODE_ENV:'test', DATABASE_URL:`sqlite:${db}`, ENCRYPTION_KEY:'a'.repeat(64),
        ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'};
      for (const workerPhase of ['seed', 'reopen']) {
        const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), workerPhase],
          {cwd:dir, env, encoding:'utf8', timeout:15000});
        assert.ifError(result.error);
        assert.equal(existsSync(db), false, 'direct worker must not create a database');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /fixture validation: worker requires parent fixture arguments/);
      }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
  scratchTest('worker rejects a database outside its parent fixture', () => {
    const scratch = approvedScratch();
    const dir = realpathSync(mkdtempSync(join(scratch, 'scheduler-coordinator-')));
    const outside = join(scratch, `scheduler-outside-${randomBytes(16).toString('hex')}.sqlite`);
    const token = randomBytes(32).toString('hex');
    try {
      writeFileSync(join(dir, 'fixture-owner.txt'), token, {flag:'wx'});
      const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch,
        NODE_ENV:'test', DATABASE_URL:`sqlite:${outside}`, ENCRYPTION_KEY:'a'.repeat(64),
        ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'};
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
        'seed', scratch, dir, outside, token], {cwd:dir, env, encoding:'utf8', timeout:15000});
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fixture validation: invalid database path/);
      assert.equal(existsSync(outside), false);
      assert.equal(existsSync(join(dir, 'fixture.sqlite')), false);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
  scratchTest('worker rejects a caller-supplied nested scratch root', () => {
    const scratch = approvedScratch();
    const outer = mkdtempSync(join(scratch, 'scheduler-nested-'));
    const fakeScratch = realpathSync(outer);
    const dir = realpathSync(mkdtempSync(join(fakeScratch, 'scheduler-coordinator-')));
    const db = join(dir, 'fixture.sqlite');
    const token = randomBytes(32).toString('hex');
    try {
      writeFileSync(join(dir, 'fixture-owner.txt'), token, {flag:'wx'});
      const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch,
        NODE_ENV:'test', DATABASE_URL:`sqlite:${db}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20)};
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
        'reopen', fakeScratch, dir, db, token], {cwd:dir, env, encoding:'utf8', timeout:15000});
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fixture validation: unapproved scratch root/);
      assert.equal(existsSync(db), false);
    } finally { rmSync(outer, {recursive:true, force:true}); }
  });
  scratchTest('worker rejects a spoofed home scratch outside the approved root', () => {
    const scratch = approvedScratch();
    const dir = realpathSync(mkdtempSync(join(scratch, 'scheduler-spoof-')));
    const fakeHome = join(dirname(scratch), `nonexistent-spoof-${randomBytes(16).toString('hex')}`);
    const fakeScratch = join(fakeHome, ...(process.platform === 'win32'
      ? ['AppData', 'Local', 'hermes', 'cache', 'scratch'] : ['.hermes', 'cache', 'scratch']));
    const fakeDir = join(fakeScratch, 'scheduler-coordinator-abcdef');
    const db = join(fakeDir, 'fixture.sqlite');
    const token = randomBytes(32).toString('hex');
    try {
      const env = {SystemRoot:process.env.SystemRoot, PATH:process.env.PATH, HOME:fakeHome, USERPROFILE:fakeHome,
        TMPDIR:fakeScratch, TEMP:fakeScratch, TMP:fakeScratch, NODE_ENV:'test', DATABASE_URL:`sqlite:${db}`,
        ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20)};
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
        'seed', fakeScratch, fakeDir, db, token], {cwd:dir, env, encoding:'utf8', timeout:15000});
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fixture validation: unapproved scratch root/);
      assert.equal(existsSync(fakeHome), false, 'worker must not create or open a database under the spoofed home');
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
  scratchTest('worker rejects an existing fake home scratch and valid marker', () => {
    const scratch = approvedScratch();
    const fakeHome = realpathSync(mkdtempSync(join(scratch, 'scheduler-fake-home-')));
    try {
      const fakeScratch = join(fakeHome, 'AppData', 'Local', 'hermes', 'cache', 'scratch');
      mkdirSync(fakeScratch, {recursive:true});
      const dir = realpathSync(mkdtempSync(join(fakeScratch, 'scheduler-coordinator-')));
      const db = join(dir, 'fixture.sqlite');
      const token = randomBytes(32).toString('hex');
      writeFileSync(join(dir, 'fixture-owner.txt'), token, {flag:'wx'});
      const env = {SystemRoot:process.env.SystemRoot, PATH:process.env.PATH, HOME:fakeHome, USERPROFILE:fakeHome,
        TMPDIR:fakeScratch, TEMP:fakeScratch, TMP:fakeScratch, NODE_ENV:'test', DATABASE_URL:`sqlite:${db}`,
        ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20)};
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
        'seed', realpathSync(fakeScratch), dir, db, token], {cwd:dir, env, encoding:'utf8', timeout:15000});
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fixture validation: unapproved scratch root/);
      assert.equal(existsSync(db), false);
    } finally { rmSync(fakeHome, {recursive:true, force:true}); }
  });
  scratchTest('worker rejects a mismatched owner marker before opening SQLite', () => {
    const scratch = approvedScratch();
    const dir = realpathSync(mkdtempSync(join(scratch, 'scheduler-coordinator-')));
    const db = join(dir, 'fixture.sqlite');
    const token = randomBytes(32).toString('hex');
    try {
      writeFileSync(join(dir, 'fixture-owner.txt'), 'wrong owner', {flag:'wx'});
      const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH,
        TMPDIR:scratch, TEMP:scratch, TMP:scratch, NODE_ENV:'test', DATABASE_URL:`sqlite:${db}`,
        ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20)};
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
        'seed', scratch, dir, db, token], {cwd:dir, env, encoding:'utf8', timeout:15000});
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fixture validation: owner marker mismatch/);
      assert.equal(existsSync(db), false);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
  scratchTest('worker rejects a dangling database symlink before opening SQLite', t => {
    const scratch = approvedScratch();
    const dir = realpathSync(mkdtempSync(join(scratch, 'scheduler-coordinator-')));
    const db = join(dir, 'fixture.sqlite');
    const target = join(dir, 'missing-target.sqlite');
    const token = randomBytes(32).toString('hex');
    try {
      writeFileSync(join(dir, 'fixture-owner.txt'), token, {flag:'wx'});
      try { symlinkSync(target, db, 'file'); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`symlinks unavailable: ${error.code}`); return; }
        throw error;
      }
      const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH,
        TMPDIR:scratch, TEMP:scratch, TMP:scratch, NODE_ENV:'test', DATABASE_URL:`sqlite:${db}`,
        ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20)};
      const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url),
        'seed', scratch, dir, db, token], {cwd:dir, env, encoding:'utf8', timeout:15000});
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fixture validation: database must be a regular file, not a link/);
      assert.ok(lstatSync(db).isSymbolicLink());
      assert.equal(existsSync(target), false);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
  scratchTest('scheduler and real coordinator preserve a full observation across restart', () => {
    const scratch = approvedScratch();
    const dir = realpathSync(mkdtempSync(join(scratch, 'scheduler-coordinator-')));
    const dbPath = join(dir, 'fixture.sqlite');
    const token = randomBytes(32).toString('hex');
    try {
      writeFileSync(join(dir, 'fixture-owner.txt'), token, {flag:'wx'});
      const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch,
        NODE_ENV:'test', DATABASE_URL:`sqlite:${join(dir,'fixture.sqlite')}`, ENCRYPTION_KEY:'a'.repeat(64),
        ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'};
      const file = fileURLToPath(import.meta.url);
      for (const workerPhase of ['seed','reopen']) {
        const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), file, workerPhase, scratch, dir, dbPath, token],
          {cwd:dir, env, encoding:'utf8', timeout:15000});
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${workerPhase} failed: ${result.stderr}\n${result.stdout}`);
      }
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
}
