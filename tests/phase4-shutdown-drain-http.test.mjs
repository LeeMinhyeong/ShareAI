// ADR 0016 item 2 acceptance: a real server process drains in-flight request work (dispatch,
// settlement, usage logging) before exiting, and refuses new work once shutdown starts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';

const completeStream = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const loader = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
const body = stream => JSON.stringify({model:'gpt-4o-mini', messages:[{role:'user', content:'hi'}], stream});

async function fixture(mode = '') {
  const dir = mkdtempSync(path.join(process.env.TMPDIR, 'shutdown-drain-'));
  const file = path.join(dir, 'db.sqlite');
  const held = []; let dispatched; const firstDispatch = new Promise(r => dispatched = r); let calls = 0;
  const provider = http.createServer((req, res) => { calls++; req.resume(); held.push(res); dispatched(); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const child = fork(fileURLToPath(new URL('./phase4-shutdown-drain-worker.mjs', import.meta.url)), [file, String(provider.address().port), mode],
    {cwd: process.env.TMPDIR, execArgv: ['--import', loader], stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let stderr = '', stdout = ''; child.stderr.on('data', d => { stderr += d; }); child.stdout.on('data', d => { stdout += d; });
  const exited = new Promise(r => child.once('exit', code => r(code)));
  const [msg] = await Promise.race([once(child, 'message'), exited.then(code => { throw new Error(`worker exited ${code}: ${stderr}`); })]);
  const release = () => { for (const res of held.splice(0)) { res.writeHead(200, {'content-type':'text/event-stream'}); res.end(completeStream); } };
  const cleanup = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); rmSync(dir, {recursive:true, force:true}); };
  return {file, port: msg.port, child, exited, firstDispatch, release, calls: () => calls, stderr: () => stderr, stdout: () => stdout, cleanup};
}
// Connection: close so no idle keep-alive socket keeps the worker alive after a response: whatever
// keeps the process alive for post-response work must be the server's own drain, not the client.
const send = (port, stream, signal, agent = false) => new Promise((resolve, reject) => {
  const payload = body(stream);
  const req = http.request({host:'127.0.0.1', port, path:'/v1/chat/completions', method:'POST', agent, signal,
    headers:{authorization:'Bearer fixture-key', 'content-type':'application/json', 'content-length':Buffer.byteLength(payload), ...(agent ? {} : {connection:'close'})}}, res => {
    const chunks = []; const done = new Promise((ok, fail) => { res.on('data', c => chunks.push(c)); res.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); res.on('error', fail); res.on('aborted', () => fail(new Error('aborted'))); });
    done.catch(() => {});
    resolve({status: res.statusCode, headers: res.headers, text: () => done});
  });
  req.on('error', reject); req.end(payload);
});
const read = file => { const db = new Database(file, {readonly:true}); try { return {
  usage: db.prepare('SELECT success FROM usage_logs').all(),
  open: db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n,
  restrictions: db.prepare('SELECT kind, duration_ms FROM account_429_v2_restrictions').all(),
}; } finally { db.close(); } };
// A refused request must not reach the provider: either 503 or a refused connection.
async function refused(port) {
  try { const r = await send(port, false); return r.status === 503 ? 'refused-503' : `admitted-${r.status}`; }
  catch { return 'refused-connection'; }
}

for (const stream of [false, true]) test(`in-flight ${stream ? 'stream' : 'non-stream'} request completes, settles and logs before exit; new work is refused`, {timeout: 20000}, async () => {
  const f = await fixture();
  try {
    const inFlight = send(f.port, stream);
    await f.firstDispatch;
    f.child.send('shutdown');
    await new Promise(r => setTimeout(r, 200));
    assert.match(await refused(f.port), /^refused-/);
    assert.equal(f.calls(), 1, 'refused work never reached the provider');
    f.release();
    const response = await inFlight;
    assert.equal(response.status, 200);
    assert.equal(response.headers.connection, 'close');
    const text = await response.text();
    assert.match(text, /ok/);
    assert.equal(await f.exited, 0, f.stderr());
    const state = read(f.file);
    assert.deepEqual(state.usage, [{success:1}], 'usage logged before exit');
    assert.equal(state.open, 0, 'OPEN settled before exit');
    assert.deepEqual(state.restrictions, []);
  } finally { await f.cleanup(); }
});

test('a client abort during shutdown still converts the OPEN to a 60s restriction before exit', {timeout: 20000}, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const inFlight = send(f.port, true, controller.signal).catch(() => 'aborted');
    await f.firstDispatch;
    f.child.send('shutdown');
    await new Promise(r => setTimeout(r, 200));
    controller.abort();
    assert.equal(await inFlight, 'aborted');
    assert.equal(await f.exited, 0, f.stderr());
    const state = read(f.file);
    assert.equal(state.open, 0, 'the aborted OPEN was converted, not stranded');
    assert.deepEqual(state.restrictions, [{kind:'upstream', duration_ms:60000}]);
    assert.equal(state.usage.length, 1, 'the dispatched attempt was logged');
    assert.equal(state.usage[0].success, 0);
    f.release();
  } finally { await f.cleanup(); }
});

test('post-response DB work (success accounting, usage log) is drained before exit', {timeout: 20000}, async () => {
  const f = await fixture('slow-post-response');
  try {
    const inFlight = send(f.port, false);
    await f.firstDispatch;
    f.child.send('shutdown');
    f.release();
    const response = await inFlight;
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(await f.exited, 0, f.stderr());
    assert.match(f.stdout(), /POST_RESPONSE_DONE/, 'the process waited for work after the response');
    assert.deepEqual(read(f.file).usage, [{success:1}], 'usage logged after the response but before exit');
  } finally { await f.cleanup(); }
});

// Real clients keep connections alive. Once shutdown has started, an idle keep-alive connection must
// not hold the process (and the 5s deadline) open after its in-flight request completes.
test('a keep-alive client does not delay exit after its in-flight request completes', {timeout: 20000}, async () => {
  const f = await fixture();
  const agent = new http.Agent({keepAlive: true, keepAliveMsecs: 60000});
  try {
    const inFlight = send(f.port, false, undefined, agent);
    await f.firstDispatch;
    f.child.send('shutdown');
    await new Promise(r => setTimeout(r, 200));
    f.release();
    const response = await inFlight;
    assert.equal(response.status, 200);
    await response.text();
    const done = performance.now();
    assert.equal(await f.exited, 0, f.stderr());
    assert.ok(performance.now() - done < 1500, `exit took ${Math.round(performance.now() - done)}ms after the response`);
  } finally { agent.destroy(); await f.cleanup(); }
});
