import { test } from 'node:test';
import assert from 'node:assert/strict';

const modulePath = '../src/db/experimental-429-scheduler.ts';

function timers() {
  let now = 0, next = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, {fn, ms}); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) { now += ms; },
    fire() { const [id, task] = pending.entries().next().value ?? []; assert.ok(task); pending.delete(id); now += task.ms; task.fn(); return task.ms; },
    get size() { return pending.size; },
    get delay() { return pending.values().next().value?.ms; },
  };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
const opts = (clock, extra = {}) => ({ timers: clock, intervalMs: 10, maxAttempts: 3, lifetimeMs: 1000, backoffMs: 5, maxBackoffMs: 20, ...extra });

test('serial ticks schedule only after settlement and stop waits for coordinator', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), tick = deferred(), shutdown = deferred();
  let calls = 0, stops = 0;
  const s = new Experimental429Scheduler({ tick() { calls++; return tick.promise; }, stop() { stops++; return shutdown.promise; } }, opts(clock));
  const done = s.start();
  await flush(); assert.equal(calls, 1); assert.equal(clock.size, 0);
  tick.resolve(); await flush(); assert.equal(clock.delay, 10);
  const stop = s.stop(); assert.strictEqual(s.stop(), stop); assert.equal(clock.size, 0);
  let finished = false; done.then(() => { finished = true; }); await flush(); assert.equal(finished, false);
  shutdown.resolve(); await stop; await done; assert.equal(stops, 1); assert.equal(calls, 1);
});

test('attempt limit stops after exactly the configured number of ticks', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(); let calls = 0, stops = 0;
  const s = new Experimental429Scheduler({ async tick() { calls++; }, async stop() { stops++; } }, opts(clock));
  const done = s.start(); await flush(); clock.fire(); await flush(); clock.fire(); await done;
  assert.equal(calls, 3); assert.equal(stops, 1); assert.equal(clock.size, 0);
});

test('clock-like SQLITE_BUSY tick error is terminal and awaits coordinator stop', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), shutdown = deferred();
  const error = Object.assign(new Error('injected clock failure'), {code: 'SQLITE_BUSY'});
  let calls = 0, stops = 0, settled = false;
  const s = new Experimental429Scheduler({ async tick() { calls++; throw error; }, stop() { stops++; return shutdown.promise; } }, opts(clock));
  const done = s.start();
  done.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  const beforeStop = {calls, stops, timers: clock.size, settled};
  const stopped = s.stop();
  await flush();
  const settledBeforeShutdown = settled;
  shutdown.resolve();
  let cause;
  try { await stopped; } catch (e) { cause = e; }
  assert.deepEqual(beforeStop, {calls: 1, stops: 1, timers: 0, settled: false});
  assert.equal(settledBeforeShutdown, false);
  assert.strictEqual(cause, error);
});

test('busy-like errors terminate without retry and preserve identity', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(); let calls = 0;
  const error = {code: 'SQLITE_BUSY_SNAPSHOT'};
  const s = new Experimental429Scheduler({ async tick() { calls++; throw error; }, async stop() {} }, opts(clock, {maxAttempts: 5}));
  await assert.rejects(s.start(), e => e === error);
  assert.equal(calls, 1); assert.equal(clock.size, 0);
});

test('unknown errors including hostile code getters terminate visibly', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  for (const error of [new Error('SQLITE_BUSY'), {code:'SQLITE_BUSY_FAKE'}, Object.defineProperty({}, 'code', {get() { throw Error('getter'); }})]) {
    const clock = timers(); let stops = 0;
    const s = new Experimental429Scheduler({ async tick() { throw error; }, async stop() { stops++; } }, opts(clock));
    await assert.rejects(s.start(), e => e === error); assert.equal(stops, 1); assert.equal(clock.size, 0);
  }
});

test('soft lifetime is checked after a long tick', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), pending = deferred(); let calls = 0;
  const s = new Experimental429Scheduler({ tick() { calls++; return pending.promise; }, async stop() {} }, opts(clock, {lifetimeMs: 50}));
  const done = s.start(); await flush(); clock.advance(60); pending.resolve(); await done;
  assert.equal(calls, 1); assert.equal(clock.size, 0);
});

test('stop during tick waits for tick and stop, preserving late tick failure', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), pending = deferred(), error = new Error('tick failed');
  const s = new Experimental429Scheduler({ tick() { return pending.promise; }, async stop() {} }, opts(clock));
  const done = s.start(); await flush(); const stopped = s.stop(); let settled = false;
  done.then(() => { settled = true; }, () => { settled = true; }); await flush(); assert.equal(settled, false);
  pending.reject(error); await assert.rejects(stopped, e => e === error); assert.equal(clock.size, 0);
});

test('SQLite-like error codes alone never authorize retry', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  for (const code of ['SQLITE_BUSY','SQLITE_BUSY_RECOVERY','SQLITE_BUSY_SNAPSHOT','SQLITE_BUSY_TIMEOUT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE','SQLITE_LOCKED_VTAB']) {
    const clock = timers(); let calls = 0; const error = {code};
    const s = new Experimental429Scheduler({ async tick() { calls++; throw error; }, async stop() {} }, opts(clock, {maxAttempts: 2}));
    await assert.rejects(s.start(), e => e === error); assert.equal(calls, 1, code); assert.equal(clock.size, 0);
  }
});

test('clock faults are terminal and stop still runs', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  for (const value of [NaN, -1, Infinity]) {
    const clock = timers(); clock.now = () => value; let stops = 0;
    const s = new Experimental429Scheduler({ async tick() { assert.fail('unexpected tick'); }, async stop() { stops++; } }, opts(clock));
    await assert.rejects(s.start(), /Invalid scheduler clock/); assert.equal(stops, 1);
  }
});

test('shutdown errors and tick errors both remain visible', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), pending = deferred(), tickError = Error('tick'), stopError = Error('stop');
  const s = new Experimental429Scheduler({ tick() { return pending.promise; }, async stop() { throw stopError; } }, opts(clock));
  const done = s.start(); await flush(); s.stop(); pending.reject(tickError);
  await assert.rejects(done, e => e instanceof AggregateError && e.errors.includes(tickError) && e.errors.includes(stopError));
});

test('stop before start prevents any tick and returns shared completion', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(); let ticks = 0, stops = 0;
  const s = new Experimental429Scheduler({ async tick() { ticks++; }, async stop() { stops++; } }, opts(clock));
  const done = s.stop(); assert.strictEqual(s.start(), done); await done; assert.equal(ticks, 0); assert.equal(stops, 1);
});

test('timer setup failure is terminal and stop completes before rejection', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), shutdown = deferred(), error = Error('setTimeout');
  clock.setTimeout = () => { throw error; };
  let stops = 0, settled = false;
  const s = new Experimental429Scheduler({ async tick() {}, stop() { stops++; return shutdown.promise; } }, opts(clock));
  const done = s.start(); done.then(() => { settled = true; }, () => { settled = true; });
  await flush(); assert.equal(stops, 1); assert.equal(settled, false);
  shutdown.resolve(); await assert.rejects(done, e => e === error);
});

test('timer clear failure wakes loop and preserves failure while awaiting stop', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  const clock = timers(), shutdown = deferred(), error = Error('clearTimeout');
  const clear = clock.clearTimeout; clock.clearTimeout = id => { clear(id); throw error; };
  let settled = false;
  const s = new Experimental429Scheduler({ async tick() {}, stop() { return shutdown.promise; } }, opts(clock));
  const done = s.start(); done.then(() => { settled = true; }, () => { settled = true; });
  await flush(); assert.equal(clock.size, 1); s.stop(); await flush();
  assert.equal(clock.size, 0); assert.equal(settled, false);
  shutdown.resolve(); await assert.rejects(done, e => e === error);
});

test('timer option bounds and failed-constructor ownership', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  let stops = 0;
  const coordinator = { async tick() {}, async stop() { stops++; } };
  for (const field of ['intervalMs', 'lifetimeMs', 'backoffMs', 'maxBackoffMs']) {
    for (const n of [0, 1.5, 2147483648]) {
      assert.throws(() => new Experimental429Scheduler(coordinator, opts(timers(), {[field]: n})), /Invalid scheduler options/);
    }
  }
  assert.equal(stops, 0);
  const scheduler = new Experimental429Scheduler(coordinator, opts(timers(), {intervalMs: 2147483647, lifetimeMs: 2147483647, backoffMs: 2147483647, maxBackoffMs: 2147483647}));
  await scheduler.stop(); assert.equal(stops, 1);
});

test('invalid options are rejected', async () => {
  const { Experimental429Scheduler } = await import(modulePath);
  for (const extra of [{maxAttempts: Infinity}, {lifetimeMs: 0}, {backoffMs: 21}, {intervalMs: NaN}]) {
    assert.throws(() => new Experimental429Scheduler({ async tick() {}, async stop() {} }, opts(timers(), extra)), /Invalid scheduler options/);
  }
});
