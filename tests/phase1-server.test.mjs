import net from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function start() {
  const child = fork(path.resolve('tests/phase1-server-child.mjs'), [], { cwd: process.env.TMPDIR, execArgv: ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(([code]) => { throw new Error(`server exited ${code}: ${errors}`); })]);
  return { child, port: ready.port };
}
async function stop(child) {
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
}
test('CORS preflight permits PUT', async () => {
  const { child, port } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/test`, { method: 'OPTIONS', headers: { origin: 'https://example.test', 'access-control-request-method': 'PUT' } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods'), /\bPUT\b/);
  } finally { await stop(child); }
});
test('health returns liveness status', async () => {
  const { child, port } = await start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  } finally { await stop(child); }
});
test('shutdown drains an active request before closing database', async () => {
  const { child, port } = await start();
  const socket = net.connect(port, '127.0.0.1');
  let response = '';
  socket.on('data', chunk => { response += chunk; });
  socket.on('error', () => {});
  const ended = once(socket, 'close');
  try {
    await once(socket, 'connect');
    socket.write('POST /v1/test-db-body HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{');
    await new Promise(resolve => setTimeout(resolve, 150));
    const exited = once(child, 'exit');
    child.send('shutdown');
    await new Promise(resolve => setTimeout(resolve, 150));
    socket.write('}');
    await ended;
    await exited;
    assert.match(response, /^HTTP\/1\.1 200/);
    assert.match(response, /"database":"open"/);
  } finally { socket.destroy(); await stop(child); }
});
test('shutdown waits for disconnected refresh to persist rotated credentials', { timeout: 5000 }, async () => {
  const { child, port } = await start();
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const started = once(child, 'message');
    socket.write('GET /v1/test-refresh HTTP/1.1\r\nHost: localhost\r\n\r\n');
    assert.equal((await started)[0].refresh, 'started');
    const closed = once(socket, 'close'); socket.destroy(); await closed;
    const exited = once(child, 'exit'); child.send('shutdown');
    const [code] = await exited;
    assert.equal(code, 0);
    assert.match(output, /REFRESH_SAVED:rotated/);
    assert.doesNotMatch(output, /REFRESH_ERROR/);
  } finally { socket.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
test('shutdown blocks a refresh initiated after a disconnected handler resumes', { timeout: 5000 }, async () => {
  const { child, port } = await start();
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const started = once(child, 'message');
    socket.write('GET /v1/test-refresh?late=1 HTTP/1.1\r\nHost: localhost\r\n\r\n');
    assert.equal((await started)[0].refresh, 'waiting');
    const closed = once(socket, 'close'); socket.destroy(); await closed;
    const exited = once(child, 'exit'); child.send('shutdown');
    assert.equal((await exited)[0], 0);
    assert.match(output, /REFRESH_ERROR:Token refresh unavailable during shutdown/);
    assert.doesNotMatch(output, /REFRESH_SAVED/);
  } finally { socket.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
test('shutdown deadline bounds a stalled token exchange', { timeout: 9000 }, async () => {
  const { child, port } = await start();
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const started = once(child, 'message');
    socket.write('GET /v1/test-refresh?stall=1 HTTP/1.1\r\nHost: localhost\r\n\r\n');
    assert.equal((await started)[0].refresh, 'started');
    const closed = once(socket, 'close'); socket.destroy(); await closed;
    const exited = once(child, 'exit'); child.send('shutdown');
    assert.equal((await exited)[0], 1);
  } finally { socket.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
test('disconnected async handler cannot reopen database after shutdown', { timeout: 5000 }, async () => {
  const { child, port } = await start();
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const started = once(child, 'message');
    socket.write('GET /v1/test-delayed-db HTTP/1.1\r\nHost: localhost\r\n\r\n');
    assert.equal((await started)[0].handler, 'started');
    const closed = once(socket, 'close'); socket.destroy(); await closed;
    const exited = once(child, 'exit'); child.send('shutdown'); await exited;
    assert.match(output, /DELAYED_DB_CLOSED/);
    assert.doesNotMatch(output, /DELAYED_DB_REOPENED/);
  } finally { socket.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('shutdown closes an active OAuth callback listener', { timeout: 5000 }, async () => {
  const { child } = await start();
  try {
    const message = once(child, 'message'); child.send('oauth');
    const [{ oauthPort, listening }] = await message;
    assert.equal(listening, true); assert.ok(oauthPort);
    const response = await fetch(`http://127.0.0.1:${oauthPort}/`);
    assert.equal(response.status, 404);
    const exited = once(child, 'exit'); child.send('shutdown');
    const outcome = await Promise.race([exited.then(() => 'exited'), new Promise(resolve => setTimeout(() => resolve('timeout'), 1800))]);
    assert.equal(outcome, 'exited');
    await assert.rejects(fetch(`http://127.0.0.1:${oauthPort}/`));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('automatic callback and manual completion exchange only once', { timeout: 5000 }, async () => {
  const { child } = await start();
  let socket;
  try {
    const setup = once(child, 'message'); child.send('oauth-concurrent');
    const [{ oauthPort, state }] = await setup;
    socket = net.connect(oauthPort, '127.0.0.1'); socket.on('error', () => {});
    await once(socket, 'connect');
    const started = once(child, 'message');
    socket.write(`GET /auth/callback?code=test&state=${state} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    assert.equal((await started)[0].exchange, 'started');
    const done = once(child, 'message'); child.send('oauth-manual');
    assert.deepEqual((await done)[0], { rejected: true, count: 1, saves: 1 });
  } finally { socket?.destroy(); await stop(child); }
});
test('shutdown aborts and drains a disconnected OAuth exchange', { timeout: 6000 }, async () => {
  const { child } = await start();
  let socket;
  try {
    const setup = once(child, 'message'); child.send('oauth-hang');
    const [{ oauthPort, state }] = await setup;
    socket = net.connect(oauthPort, '127.0.0.1'); socket.on('error', () => {});
    await once(socket, 'connect');
    const started = once(child, 'message');
    socket.write(`GET /auth/callback?code=test&state=${state} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    assert.equal((await started)[0].exchange, 'started');
    const closed = once(socket, 'close'); socket.destroy(); await closed;
    const exited = once(child, 'exit'); child.send('shutdown');
    const outcome = await Promise.race([exited.then(([code]) => code), new Promise(resolve => setTimeout(() => resolve('timeout'), 2500))]);
    assert.equal(outcome, 0);
  } finally { socket?.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
test('OAuth relisten waits for previous callback server close', { timeout: 5000 }, async () => {
  const { child } = await start();
  try {
    const response = once(child, 'message'); child.send('oauth-race');
    const [result] = await response;
    assert.equal(result.relistening, true);
  } finally { await stop(child); }
});
test('successful drain cancels the shutdown deadline', { timeout: 9000 }, async () => {
  const { child } = await start();
  try {
    const ready = once(child, 'message'); child.send('keepalive'); await ready;
    const exited = once(child, 'exit'); child.send('shutdown');
    const [code] = await exited;
    assert.equal(code, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
test('shutdown bounds waiting for an incomplete request', { timeout: 9000 }, async () => {
  const { child, port } = await start();
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    socket.write('POST /health HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    await new Promise(resolve => setTimeout(resolve, 150));
    const exited = once(child, 'exit');
    child.send('shutdown');
    const outcome = await Promise.race([exited.then(([code]) => code), new Promise(resolve => setTimeout(() => resolve('timeout'), 6500))]);
    assert.equal(outcome, 1);
  } finally { socket.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('unsupported JSON charset returns 415', async () => {
  const { child, port } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', headers: { 'content-type': 'application/json; charset=iso-8859-1' }, body: '{}' });
    assert.equal(res.status, 415);
  } finally { await stop(child); }
});
test('oversized JSON returns 413', async () => {
  const { child, port } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '"' + 'x'.repeat(10 * 1024 * 1024) + '"' });
    assert.equal(res.status, 413);
  } finally { await stop(child); }
});
test('JSON parser errors include configured CORS headers', async () => {
  const { child, port } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: '{' });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.test');
  } finally { await stop(child); }
});
test('malformed JSON returns 400 rather than 500', async () => {
  const { child, port } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(res.status, 400);
  } finally { await stop(child); }
});
