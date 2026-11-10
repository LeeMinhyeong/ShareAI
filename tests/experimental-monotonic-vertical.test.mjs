// Test-only synthetic HTTP integration, not a production router or provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';

function bounded(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); reject(new Error(`${label} cleanup timeout`)); }
      catch (cause) { reject(new Error(`${label} cleanup timeout`, { cause })); }
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function stopChild(p, ms = 2000, terminate = true) {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  let onExit;
  const exited = new Promise(resolve => { onExit = resolve; p.once('exit', onExit); });
  if (terminate) p.kill();
  return bounded(exited, ms, 'child', () => p.kill('SIGKILL'))
    .finally(() => p.off('exit', onExit));
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return sockets;
}

function stopServer(server, sockets, ms = 2000) {
  if (!server.listening) return Promise.resolve();
  const closed = new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return bounded(closed, ms, 'server', () => { for (const socket of sockets) socket.destroy(); });
}

async function cleanup(children, provider, sockets, db, dir) {
  const errors = [];
  try { if (db) { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); } } catch (e) { errors.push(e); }
  try {
    const results = await Promise.allSettled([
      ...children.map(({ p }) => Promise.resolve().then(() => stopChild(p))),
      ...(provider ? [Promise.resolve().then(() => stopServer(provider, sockets))] : []),
    ]);
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { errors.push(e); }
  }
  if (errors.length) throw new AggregateError(errors, `cleanup failed: ${errors.map(e => e.message).join('; ')}`);
}

function launch(file, env) {
  const p = fork(new URL(file, import.meta.url), [], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const queue = []; const waiters = [];
  p.on('message', msg => { const i = waiters.findIndex(w => w.match(msg)); if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg); });
  p.on('exit', () => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(`child exited ${p.exitCode}`)); } });
  function wait(match) { const i = queue.findIndex(match); if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]); return new Promise((resolve, reject) => { const w = { match, resolve, reject }; w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('child message timeout')); }, 4000); waiters.push(w); }); }
  let id = 0;
  return { p, event: name => wait(m => m.event === name || m.event === 'error').then(m => { if (m.event === 'error') throw new Error(m.error); return m; }), send: m => p.send(m), async call(op, data = {}) { const n = ++id; p.send({ id: n, op, ...data }); const m = await wait(x => x.id === n); if (m.error) throw new Error(m.error); return m.value; } };
}

test('bounded cleanup reports stalled child and server', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const server = http.createServer();
  let client;
  try {
    const sockets = trackSockets(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    client = net.connect(server.address().port, '127.0.0.1');
    await new Promise(resolve => server.once('connection', resolve));
    await assert.rejects(stopChild(child, 50, false), /child cleanup timeout/);
    await assert.rejects(stopServer(server, sockets, 50), /server cleanup timeout/);
  } finally {
    client?.destroy();
    child.kill();
    server.closeAllConnections();
    server.close();
  }
});

test('429 observation fences another process; delayed writer rejects stale sample', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'mono-vertical-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\mono-${randomBytes(16).toString('hex')}` : join(dir, 'clock.sock');
  const env = { CLOCK_PATH: path, CLOCK_TOKEN: randomBytes(32).toString('hex'), DB_PATH: join(dir, 'test.sqlite') };
  const children = []; let provider, sockets, db;
  const start = (file, extra = {}) => { const w = launch(file, { ...env, ...extra }); children.push(w); return w; };
  try {
    const calls = [];
    provider = http.createServer((req, res) => { calls.push(req.url); res.writeHead(req.url === '/A' ? 429 : 200).end(); });
    sockets = trackSockets(provider);
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    assert.notEqual(provider.address().port, 20128);
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    let clock = start('./experimental-monotonic-worker.mjs', { ROLE: 'clock' }); await clock.call('ready');
    const router = () => start('./experimental-monotonic-vertical-worker.mjs', { PROVIDER_URL: providerUrl });
    let a = router(); const ar = await a.event('ready'); let b = router(); const br = await b.event('ready');
    db = new Database(env.DB_PATH); db.pragma('busy_timeout=0');
    let settled = false;
    const first = fetch(`http://127.0.0.1:${ar.port}/`).then(r => { settled = true; return r; });
    const obs = await a.event('observed'); assert.equal(obs.account, 'A');
    assert.deepEqual(db.prepare('SELECT account FROM test_open').all(), [{ account: 'A' }]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM experimental_cooldown').get().n, 0);
    const second = await fetch(`http://127.0.0.1:${br.port}/`);
    assert.equal(second.status, 200); assert.equal(second.headers.get('x-account'), 'B');
    assert.deepEqual(calls, ['/A', '/B']);
    for (const value of [9999999999999, -9999999999999]) { a.send({ op: 'wallJump', value }); await a.event('wallJump'); b.send({ op: 'wallJump', value }); await b.event('wallJump'); await clock.call('wallJump', { delta: value }); }
    // Hold a real competing writer after observation and before cooldown finish.
    db.exec('BEGIN IMMEDIATE'); a.send({ op: 'release' }); await a.event('writerBusy');
    await clock.call('advance', { ticks: '2000000000' }); await sleep(150);
    assert.equal(settled, false); db.exec('COMMIT');
    assert.equal((await first).status, 429);
    const row = db.prepare('SELECT epoch, deadline FROM experimental_cooldown WHERE account=?').safeIntegers().get('A');
    assert.equal(row.epoch, obs.epoch); assert.ok(row.deadline >= BigInt(obs.tick) + 3000000000n);
    b.send({ op: 'allowed', account: 'A' }); assert.equal((await b.event('allowed')).result, false);
    await stopChild(a.p); a = router(); await a.event('ready');
    a.send({ op: 'allowed', account: 'A' }); assert.equal((await a.event('allowed')).result, false);
    await clock.call('advance', { ticks: '999999999' });
    b.send({ op: 'allowed', account: 'A' }); assert.equal((await b.event('allowed')).result, false);
    await clock.call('advance', { ticks: '1' });
    b.send({ op: 'allowed', account: 'A' }); assert.equal((await b.event('allowed')).result, true);
    // The real operation samples first, then a separate process holds the writer until stale.
    for (const operation of ['limit', 'allowed']) {
      b.send({ op: 'sampleOperation', operation, account: `fresh-${operation}`, pause: false });
      assert.equal((await b.event('sampleResult')).result, true, `${operation} positive control`);
      b.send({ op: 'sampleOperation', operation, account: `stale-${operation}`, pause: true });
      await b.event('sampleReady');
      db.exec('BEGIN IMMEDIATE');
      await sleep(180);
      db.exec('COMMIT');
      b.send({ op: 'releaseSample' });
      const result = await b.event('sampleResult');
      if (operation === 'limit') assert.equal(result.error, 'stale clock reading');
      else { assert.equal(result.error, undefined); assert.equal(result.result, false); }
      assert.equal(db.prepare('SELECT count(*) AS n FROM experimental_cooldown WHERE account=?').get(`stale-${operation}`).n, 0);
    }
    // A clock restart creates an unresolved epoch, even after old expiry.
    await clock.call('stop'); clock = start('./experimental-monotonic-worker.mjs', { ROLE: 'clock' }); await clock.call('ready');
    a.send({ op: 'allowed', account: 'A' }); assert.equal((await a.event('allowed')).result, false);
    assert.deepEqual(calls, ['/A', '/B']);
  } finally {
    await cleanup(children, provider, sockets, db, dir);
  }
});

test('genuine monotonic elapsed time expires a durable cooldown', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'mono-elapsed-'));
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\mono-${randomBytes(16).toString('hex')}` : join(dir, 'clock.sock');
  const env = { CLOCK_PATH: path, CLOCK_TOKEN: randomBytes(32).toString('hex'), DB_PATH: join(dir, 'test.sqlite') };
  const clock = launch('./experimental-monotonic-worker.mjs', { ...env, ROLE: 'realclock' });
  let router;
  try {
    await clock.call('ready');
    router = launch('./experimental-monotonic-worker.mjs', { ...env, ROLE: 'router' }); await router.call('ready');
    await router.call('limit', { account: 'A', duration: '1000000000' });
    assert.equal(await router.call('allowed', { account: 'A' }), false);
    await sleep(1200);
    assert.equal(await router.call('allowed', { account: 'A' }), true);
  } finally {
    await cleanup([clock, router].filter(Boolean), null, null, null, dir);
  }
});
