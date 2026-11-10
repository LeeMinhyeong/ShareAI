import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

// Accidental-misconfiguration guard, not an adversarial boundary: hard links and
// filesystem replacement races remain possible. Never accept HOME as the root.
function approvedScratch() {
  assert.equal(process.platform, 'win32', 'fixture validation: unsupported host');
  return realpathSync('C:/Users/Administrator/AppData/Local/hermes/cache/scratch');
}
function scratchUnavailable(platform = process.platform, isDirectory = () => lstatSync(approvedScratch()).isDirectory()) {
  if (platform !== 'win32') return 'requires the reviewed Windows scratch workspace';
  assert.ok(isDirectory(), 'reviewed scratch workspace is not a directory');
  return false;
}
async function cleanupScheduler(scheduler, expectedError, primary, closeDatabase, state) {
  const recordFailure = error => {
    primary = state.failed ? new AggregateError([primary,error]) : error;
    state.failed = true;
  };
  try { if (scheduler) await scheduler.stop(); } catch (error) {
    if (expectedError === undefined || error !== expectedError) {
      recordFailure(error);
    }
  }
  try { closeDatabase(); } catch (error) { recordFailure(error); }
  return primary;
}
const role = process.argv[2];
if (role === 'scenario' || role === 'lock') {
  const [scratch, dir, dbPath, token] = process.argv.slice(3);
  assert.equal(process.argv.length, 7, 'fixture validation: worker requires parent fixture arguments');
  assert.ok([scratch, dir, dbPath].every(p => typeof p === 'string' && isAbsolute(p)));
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(scratch, approvedScratch(), 'fixture validation: unapproved root');
  assert.equal(realpathSync(dir), dir);
  assert.equal(dirname(dir), scratch);
  assert.match(basename(dir), /^scheduler-contention-[A-Za-z0-9]+$/);
  assert.equal(realpathSync(process.cwd()), dir);
  assert.equal(dbPath, join(dir, 'fixture.sqlite'));
  assert.equal(process.env.DATABASE_URL, `sqlite:${dbPath}`);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.ENCRYPTION_KEY, 'a'.repeat(64));
  assert.equal(process.env.ADMIN_API_KEY, 'x'.repeat(20));
  const marker = join(dir, 'fixture-owner.txt');
  assert.ok(lstatSync(marker).isFile());
  assert.equal(readFileSync(marker, 'utf8'), token);
  let stat;
  try { stat = lstatSync(dbPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (stat) assert.ok(stat.isFile(), 'fixture validation: database must be a regular file, not a link');
  assert.equal(Boolean(stat), role === 'lock', 'fixture validation: unexpected database presence');
  assert.ok(process.send, 'fixture validation: IPC required');
  const send = message => process.send(message);
  const queue = [];
  let waiter;
  process.on('message', message => { if (waiter) { const resolve = waiter; waiter = undefined; resolve(message); } else queue.push(message); });
  const receive = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { waiter = resolve; });
  if (role === 'lock') {
    const {default: Database} = await import('better-sqlite3');
    const db = new Database(dbPath, {fileMustExist:true, timeout:0});
    try {
      db.exec('BEGIN IMMEDIATE');
      assert.equal(db.inTransaction, true);
      send({type:'locked'});
      assert.equal((await receive()).type, 'release');
      db.exec('ROLLBACK');
      assert.equal(db.inTransaction, false);
      send({type:'released'});
    } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
  } else {
    const {getDb, closeDatabase} = await import('../src/db/client.ts');
    const {settleAppAttempt} = await import('../src/db/experimental-atomic-429-app.ts');
    const {CooldownCoordinator} = await import('../src/db/experimental-429-coordinator.ts');
    const {Experimental429Scheduler} = await import('../src/db/experimental-429-scheduler.ts');
    const {default: Database} = await import('better-sqlite3');
    const db = getDb();
    let scheduler, primary, expectedStopError;
    const failure = {failed:false};
    const originalExec = Database.prototype.exec;
    try {
      assert.equal(db.name, dbPath);
      db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);
INSERT INTO ordinary_account_attempts VALUES ('synthetic-id','synthetic-owner');`);
      assert.equal(await settleAppAttempt({kind:'upstream', accountId:'synthetic-id', attemptId:'synthetic-owner', durationNs:10000000n}), 1n);
      const expected = [{kind:'upstream', account_id:'synthetic-id', generation:1n, duration_ns:10000000n}];
      const rows = database => database.prepare('SELECT kind,account_id,generation,duration_ns FROM experimental_atomic_429_restrictions').safeIntegers().all();
      assert.deepEqual(rows(db), expected);
      let time = 0, timer, calls = 0, busy = 0;
      const timers = {now:() => time, setTimeout(fn, ms) { assert.equal(timer, undefined); timer={fn,ms}; return timer; }, clearTimeout(id) { assert.equal(timer,id); timer=undefined; }};
      const coordinator = new CooldownCoordinator({capacity:1, pageSize:1, clock:() => BigInt(time)*1000000n});
      const tick = coordinator.tick.bind(coordinator);
      coordinator.tick = async () => {
        calls++;
        try { return await tick(); }
        catch (error) {
          // Hold the actual error before the scheduler sees it until the parent
          // has observed the definite failing BEGIN from the real writer.
          assert.equal(error.code, 'SQLITE_BUSY');
          send({type:'tick-failed'});
          assert.equal((await receive()).type, 'deliver-error');
          throw error;
        }
      };
      scheduler = new Experimental429Scheduler(coordinator, {timers,intervalMs:9,maxAttempts:10,lifetimeMs:1000,backoffMs:1,maxBackoffMs:1});
      const done = scheduler.start();
      const outcome = done.then(() => ({ok:true}), error => ({ok:false,error}));
      for (let i=0; i<500 && !timer; i++) await Promise.resolve();
      assert.ok(timer); assert.equal(calls,1); assert.deepEqual(rows(db),expected);
      time=9; const first=timer; timer=undefined; first.fn();
      for (let i=0; i<500 && !timer; i++) await Promise.resolve();
      assert.ok(timer); assert.equal(calls,2); assert.deepEqual(rows(db),expected, 'no expiration before full duration');
      send({type:'ready'});
      assert.equal((await receive()).type, 'contend');
      Database.prototype.exec = function(sql) {
        try { return originalExec.call(this, sql); }
        catch (error) {
          if (sql === 'BEGIN IMMEDIATE' && error.code === 'SQLITE_BUSY') {
            assert.equal(this.name, dbPath); assert.equal(this.inTransaction, false);
            if (++busy === 1) send({type:'busy'});
          }
          throw error;
        }
      };
      assert.equal(timer.ms,9); time=18; const second=timer; timer=undefined; second.fn();
      const result = await outcome;
      assert.equal(result.ok, false, 'contention must not report successful completion');
      assert.equal(result.error.code, 'SQLITE_BUSY');
      assert.ok(busy >= 1); assert.equal(calls,3, 'scheduler must not retry an error of unproven provenance');
      assert.equal(timer, undefined); assert.deepEqual(rows(db),expected);
      send({type:'terminal'});
      assert.equal((await receive()).type, 'finish');
      await assert.rejects(scheduler.stop(), error => error === result.error);
      expectedStopError = result.error;
      assert.equal(calls,3); assert.equal(timer,undefined);
      await assert.rejects(tick(), /Coordinator stopped/);
      Database.prototype.exec = originalExec;
      const reopened = new Database(dbPath, {fileMustExist:true, readonly:true});
      try { assert.deepEqual(rows(reopened),expected, 'restriction survives database reopen'); }
      finally { reopened.close(); }
      // Positive control: a fresh scheduler/coordinator observes the same real
      // restriction after the other process released its writer. It must wait
      // a complete new observation before the real expiry transaction deletes it.
      const freshDb = db;
      assert.deepEqual(rows(freshDb), expected);
      time=100; timer=undefined; let freshCalls=0;
      const freshCoordinator = new CooldownCoordinator({capacity:1, pageSize:1, clock:() => BigInt(time)*1000000n});
      const freshTick = freshCoordinator.tick.bind(freshCoordinator);
      freshCoordinator.tick = async () => { freshCalls++; return freshTick(); };
      expectedStopError = undefined;
      scheduler = new Experimental429Scheduler(freshCoordinator, {timers,intervalMs:9,maxAttempts:10,lifetimeMs:1000,backoffMs:1,maxBackoffMs:1});
      const freshDone = scheduler.start();
      const freshOutcome = freshDone.then(() => ({ok:true}), error => ({ok:false,error}));
      const waitTimer = async () => {
        for (let i=0; i<500 && !timer; i++) await Promise.resolve();
        assert.ok(timer, 'fresh scheduler must complete its tick');
      };
      await waitTimer();
      assert.equal(freshCalls,1); assert.deepEqual(rows(freshDb),expected);
      assert.equal(timer.ms,9); time=109; const before=timer; timer=undefined; before.fn();
      await waitTimer();
      assert.equal(freshCalls,2); assert.deepEqual(rows(freshDb),expected, 'fresh observation is not yet complete');
      assert.equal(timer.ms,9); time=118; assert.ok(time-100 >= 10);
      const expiry=timer; timer=undefined; expiry.fn();
      await waitTimer();
      assert.equal(freshCalls,3); assert.deepEqual(rows(freshDb),[], 'unlocked expiry deletes the restriction');
      const observer = new Database(dbPath, {fileMustExist:true, readonly:true});
      try { assert.deepEqual(rows(observer),[], 'expiry is committed and visible to another connection'); }
      finally { observer.close(); }
      await scheduler.stop();
      const freshResult = await freshOutcome;
      if (!freshResult.ok) throw freshResult.error;
      assert.equal(timer,undefined);
      send({type:'verified'});
    } catch (error) { primary=error; failure.failed=true; }
    finally {
      Database.prototype.exec = originalExec;
      primary = await cleanupScheduler(scheduler, expectedStopError, primary, closeDatabase, failure);
    }
    if (failure.failed) throw primary;
  }
  process.disconnect();
} else {
  test('cleanup preserves unrelated stop failures and awaits stop before closing', async () => {
    const expected = Object.assign(new Error('observed contention'), {code:'SQLITE_BUSY'});
    const otherBusy = Object.assign(new Error('different contention'), {code:'SQLITE_BUSY'});
    const primary = new Error('primary');
    const other = new Error('other cleanup failure');
    const run = async (stopError, observed, original) => {
      let settled = false, closed = false;
      const scheduler = {async stop() { await Promise.resolve(); settled = true; throw stopError; }};
      const result = await cleanupScheduler(scheduler, observed, original, () => {
        assert.equal(settled, true, 'database must not close before stop settles');
        closed = true;
      }, {failed:original !== undefined});
      assert.equal(closed, true);
      return result;
    };
    assert.equal(await run(expected, expected, undefined), undefined);
    assert.equal(await run(expected, expected, primary), primary);
    assert.equal(await run(expected, undefined, undefined), expected);
    assert.equal(await run(otherBusy, expected, undefined), otherBusy);
    const busyCombined = await run(otherBusy, expected, primary);
    assert.ok(busyCombined instanceof AggregateError);
    assert.equal(busyCombined.errors[0], primary);
    assert.equal(busyCombined.errors[1], otherBusy);
    const combined = await run(other, expected, primary);
    assert.ok(combined instanceof AggregateError);
    assert.equal(combined.errors[0], primary);
    assert.equal(combined.errors[1], other);
    const closeError = new Error('close failure');
    const all = await cleanupScheduler({async stop() { throw other; }}, expected, primary, () => { throw closeError; }, {failed:true});
    assert.ok(all instanceof AggregateError);
    assert.equal(all.errors[0].errors[0], primary);
    assert.equal(all.errors[0].errors[1], other);
    assert.equal(all.errors[1], closeError);
  });
  test('cleanup retains falsy primary and cleanup failures', async () => {
    const values = [undefined, null, 0, false];
    for (const value of values) {
      const stopError = new Error('stop');
      const closeError = new Error('close');
      const state = {failed:true};
      const order = [];
      const combined = await cleanupScheduler({async stop() { order.push('stop'); throw stopError; }}, undefined, value, () => { order.push('close'); throw closeError; }, state);
      assert.equal(state.failed, true);
      assert.deepEqual(order, ['stop', 'close']);
      assert.ok(combined instanceof AggregateError);
      assert.ok(combined.errors[0] instanceof AggregateError);
      assert.equal(combined.errors[0].errors[0], value);
      assert.equal(combined.errors[0].errors[1], stopError);
      assert.equal(combined.errors[1], closeError);
      const suppressed = {failed:true};
      const retained = await cleanupScheduler({async stop() { throw stopError; }}, stopError, value, () => {}, suppressed);
      assert.equal(retained, value);
      assert.equal(suppressed.failed, true);

      for (const stage of ['stop', 'close']) {
        for (const hasPrimary of [false, true]) {
          const primary = new Error('primary');
          const failure = {failed:hasPrimary};
          const steps = [];
          const result = await cleanupScheduler({async stop() { steps.push('stop'); if (stage === 'stop') throw value; }}, undefined, hasPrimary ? primary : undefined, () => { steps.push('close'); if (stage === 'close') throw value; }, failure);
          assert.deepEqual(steps, ['stop', 'close']);
          assert.equal(failure.failed, true);
          if (hasPrimary) {
            assert.ok(result instanceof AggregateError);
            assert.equal(result.errors[0], primary);
            assert.equal(result.errors[1], value);
          } else assert.equal(result, value);
        }
      }
    }
  });
  test('scratch availability skips only unsupported platforms and surfaces workspace errors', () => {
    assert.match(scratchUnavailable('linux', () => { throw new Error('must not probe'); }), /requires/);
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
      const error = Object.assign(new Error(code), {code});
      assert.throws(() => scratchUnavailable('win32', () => { throw error; }), e => e === error);
    }
    assert.throws(() => scratchUnavailable('win32', () => false), /not a directory/);
    assert.equal(scratchUnavailable('win32', () => true), false);
  });
  test('real SQLite writer contention is terminal and preserves the restriction', {timeout:20000, skip:scratchUnavailable()}, async () => {
    const scratch = approvedScratch();
    const dir = realpathSync(mkdtempSync(join(scratch,'scheduler-contention-')));
    const dbPath = join(dir,'fixture.sqlite');
    const token = randomBytes(32).toString('hex');
    const children = [];
    const env = {SystemRoot:process.env.SystemRoot, USERPROFILE:homedir(), HOME:homedir(), PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch, NODE_ENV:'test', DATABASE_URL:`sqlite:${dbPath}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false'};
    let allClosed = false;
    const start = role => {
      const child = spawn(process.execPath, ['--import',import.meta.resolve('tsx'),fileURLToPath(import.meta.url),role,scratch,dir,dbPath,token], {cwd:dir,env,stdio:['ignore','pipe','pipe','ipc']});
      const state = {child, messages:[], output:'', closed:false};
      children.push(state);
      for (const stream of [child.stdout,child.stderr]) { stream.on('data', chunk => { state.output += chunk.toString(); if (state.output.length > 100000) child.kill(); }); stream.on('error', () => {}); }
      child.on('error', error => { state.error=error; });
      child.on('message', msg => state.messages.push(msg));
      state.close = new Promise(resolve => child.on('close', (code,signal) => { state.closed=true; state.code=code; state.signal=signal; resolve(); }));
      return state;
    };
    const bounded = async (promise, ms, message) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_,reject) => { timer=setTimeout(() => reject(new Error(message)),ms); })]); }
      finally { clearTimeout(timer); }
    };
    const wait = async (state,type) => {
      const deadline=Date.now()+5000;
      while (Date.now()<deadline) {
        const i=state.messages.findIndex(m => m.type===type);
        if (i>=0) { state.messages.splice(i,1); return; }
        if (state.closed || state.error) throw new Error(`worker exited before ${type}: ${state.output}`);
        await new Promise(resolve => setTimeout(resolve,10));
      }
      throw new Error(`worker timed out waiting for ${type}: ${state.output}`);
    };
    try {
      writeFileSync(join(dir,'fixture-owner.txt'),token,{flag:'wx'});
      const scenario=start('scenario');
      await wait(scenario,'ready');
      const lock=start('lock');
      await wait(lock,'locked');
      scenario.child.send({type:'contend'});
      await wait(scenario,'busy');
      await wait(scenario,'tick-failed');
      scenario.child.send({type:'deliver-error'});
      await wait(scenario,'terminal');
      lock.child.send({type:'release'});
      await wait(lock,'released');
      scenario.child.send({type:'finish'});
      await wait(scenario,'verified');
      await bounded(Promise.all(children.map(c => c.close)),5000,'worker close timeout');
      for (const c of children) assert.equal(c.code,0,`worker failed: ${c.output}`);
    } finally {
      for (const c of children) if (!c.closed) c.child.kill();
      try { await bounded(Promise.all(children.map(c => c.close)),3000,'worker termination timeout'); } catch { /* report unconfirmed children below */ }
      allClosed=children.every(c => c.closed);
      if (allClosed) rmSync(dir,{recursive:true,force:true});
      else { for (const c of children.filter(c => !c.closed)) { c.child.unref(); c.child.stdout.destroy(); c.child.stderr.destroy(); if (c.child.connected) c.child.disconnect(); } throw new Error(`worker termination unconfirmed; fixture preserved: ${dir}; pids: ${children.filter(c => !c.closed).map(c => c.child.pid).join(',')}`); }
    }
    assert.ok(allClosed);
  });
}
