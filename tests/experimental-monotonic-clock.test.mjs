import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readClock } from '../scripts/experimental-monotonic-clock.mjs';

const fixture = new URL('./experimental-monotonic-worker.mjs', import.meta.url);
function child(env) {
  const p = fork(fixture, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let id = 0; const pending = new Map();
  p.on('message', m => { const q = pending.get(m.id); if (q) { pending.delete(m.id); m.error ? q.reject(new Error(m.error)) : q.resolve(m.value); } });
  p.on('exit', () => { for (const q of pending.values()) q.reject(new Error('worker exited')); pending.clear(); });
  return { p, call(op, data = {}) { return new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); p.send({ id: n, op, ...data }); }); } };
}

test('separate clock and routers ignore wall jumps, preserve epochs and fail closed', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'mono-clock-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\mono-${randomBytes(16).toString('hex')}` : join(dir, 'clock.sock');
  const token = randomBytes(32).toString('hex'); const db = join(dir, 'test.sqlite');
  const workers = [];
  const start = (role) => { const w = child({ ROLE: role, CLOCK_PATH: path, CLOCK_TOKEN: token, DB_PATH: db }); workers.push(w); return w; };
  try {
    let clock = start('clock'); await clock.call('ready');
    let a = start('router'); await a.call('ready'); let b = start('router'); await b.call('ready');
    await a.call('limit', { account: 'A', duration: '120000000000' });
    await b.call('limit', { account: 'A', duration: '1' }); // Cannot shorten an existing deadline.
    await clock.call('wallJump', { delta: 121000 });
    await a.call('wallJump', { delta: 121000 }); await b.call('wallJump', { delta: 121000 });
    assert.equal(await b.call('allowed', { account: 'A' }), false);
    assert.equal(await b.call('allowed', { account: 'B' }), true);
    await clock.call('advance', { ticks: '119999999999' });
    assert.equal(await b.call('allowed', { account: 'A' }), false);
    await clock.call('advance', { ticks: '1' });
    assert.equal(await b.call('allowed', { account: 'A' }), true);
    await a.call('limit', { account: 'A', duration: '120000000000' });
    await a.call('stop'); a = start('router'); await a.call('ready');
    assert.equal(await a.call('allowed', { account: 'A' }), false);
    await clock.call('stop');
    assert.equal(await b.call('allowed', { account: 'B' }), false);
    clock = start('clock'); await clock.call('ready');
    assert.equal(await b.call('allowed', { account: 'A' }), false);
    assert.equal(await b.call('limit', { account: 'A', duration: '1' }), false);
    await clock.call('advance', { ticks: '200000000000' });
    assert.equal(await b.call('allowed', { account: 'A' }), false);
    await clock.call('advance', { ticks: '9007199254740993' });
    assert.equal(await b.call('limit', { account: 'C', duration: '3' }), true);
    await clock.call('advance', { ticks: '2' });
    assert.equal(await a.call('allowed', { account: 'C' }), false);
    await clock.call('advance', { ticks: '1' });
    assert.equal(await a.call('allowed', { account: 'C' }), true);
  } finally {
    for (const { p } of workers) { if (p.exitCode === null && p.signalCode === null && !p.killed) p.kill(); }
    await Promise.all(workers.map(({ p }) => p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise(r => p.once('exit', r))));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real clock process uses increasing bigint ticks and rejects a wrong token', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'mono-real-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\mono-${randomBytes(16).toString('hex')}` : join(dir, 'clock.sock');
  const token = randomBytes(32).toString('hex');
  const clock = child({ ROLE: 'realclock', CLOCK_PATH: path, CLOCK_TOKEN: token, DB_PATH: join(dir, 'unused') });
  try {
    await clock.call('ready');
    const first = await readClock({ path, token });
    const second = await readClock({ path, token });
    assert.equal(first.epoch, second.epoch);
    assert.equal(typeof first.tick, 'bigint');
    assert.ok(second.tick >= first.tick);
    await assert.rejects(readClock({ path, token: '0'.repeat(64), timeoutMs: 500 }));
    await clock.call('stop');
  } finally {
    if (clock.p.exitCode === null && clock.p.signalCode === null && !clock.p.killed) clock.p.kill();
    if (clock.p.exitCode === null && clock.p.signalCode === null) await new Promise(r => clock.p.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});
