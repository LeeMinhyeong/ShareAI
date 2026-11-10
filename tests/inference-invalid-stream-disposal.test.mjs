import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Compile the actual inference module in memory, without initializing services.
const source = readFileSync(new URL('../src/upstream/inference.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
const exports = {};
vm.runInNewContext(code, {exports, TextDecoder, fetch() { throw new Error('Unexpected network call'); }, require() { throw new Error('Unexpected import'); }});
const { infer, UpstreamError } = exports;

// Never let an unexpected thrown value become a test-runner diagnostic.
class SafeChildError extends Error {}
const test = (name, fn) => nodeTest(name, async () => {
  try { await fn(); } catch (error) {
    if (error instanceof SafeChildError) throw error;
    throw new Error('Focused inference test failed');
  }
});

const request = {model:'gpt-test', messages:[{role:'user', content:'hello'}]};
const auth = {kind:'api_key', token:'sk-synthetic'};
const endpoint = 'https://stream-fixture.invalid/v1/chat/completions';
const bodySecret = 'synthetic-body-secret-do-not-disclose';
const invokeResponse = response => async () => response;

function safeCheck(check) {
  try { return check(); }
  catch { throw new Error('Unexpected value while checking response'); }
}

async function outcome(response) {
  let timer;
  try {
    return await Promise.race([
      infer('openai', auth, request, endpoint, undefined, invokeResponse(response)).then(
        () => ({kind:'resolved'}), error => ({kind:'rejected', error})),
      new Promise(resolve => { timer = setTimeout(() => resolve({kind:'timeout'}), 100); }),
    ]);
  } catch { throw new Error('Unexpected error while obtaining response'); }
  finally { clearTimeout(timer); }
}

function assertError(result, status, message) {
  assert.equal(result.kind, 'rejected', 'response must fail without waiting for cancellation');
  assert.equal(safeCheck(() => result.error instanceof UpstreamError), true, 'unexpected error type');
  assert.equal(safeCheck(() => result.error.status === status), true, 'unexpected error status');
  for (const secret of [bodySecret, auth.token]) {
    assert.equal(safeCheck(() => String(result.error.message).includes(secret)), false, 'error message must not expose secrets');
    assert.equal(safeCheck(() => String(result.error).includes(secret)), false, 'error text must not expose secrets');
    assert.equal(safeCheck(() => JSON.stringify(result.error).includes(secret)), false, 'error must not expose secrets');
    assert.equal(safeCheck(() => String(result.error.stack).includes(secret)), false, 'stack must not expose secrets');
  }
  assert.equal(safeCheck(() => result.error.message === message), true, 'unexpected error message');
}

function secretBody() {
  return new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode(bodySecret)); }});
}

async function checkInvalidStream(cancel) {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(bodySecret)); },
    cancel() { cancelled++; return cancel(); },
  });
  const response = new Response(body, {status:200, headers:{'content-type':'application/json'}});
  let timer;
  try {
    let result;
    try {
      result = await Promise.race([
        infer('openai', auth, request, endpoint, undefined, async () => response).then(
          () => ({kind:'resolved'}), error => ({kind:'rejected', error})),
        new Promise(resolve => { timer = setTimeout(() => resolve({kind:'timeout'}), 100); }),
      ]);
    } catch { throw new Error('Unexpected error while obtaining response'); }
    assertError(result, 502, 'Upstream did not return an event stream');
    assert.equal(cancelled, 1);
  } finally { clearTimeout(timer); }
}

test('invalid stream fails promptly when body cancellation never settles', async () => {
  await checkInvalidStream(() => new Promise(() => {}));
});

test('invalid stream retains the 502 when body cancellation rejects', async () => {
  await checkInvalidStream(() => Promise.reject(new Error('synthetic cancellation failure')));
});

test('invalid stream retains the 502 when cancel itself throws synchronously', async () => {
  const body = secretBody();
  let calls = 0;
  body.cancel = () => { calls++; throw new Error('synthetic synchronous cancellation failure'); };
  const response = new Response(body, {headers:{'content-type':'application/json'}});
  assertError(await outcome(response), 502, 'Upstream did not return an event stream');
  assert.equal(calls, 1);
  assert.equal(response.bodyUsed, false);
});

test('missing content type rejects and cancels without exposing body', async () => {
  const body = secretBody();
  const cancel = body.cancel.bind(body);
  let calls = 0;
  body.cancel = () => { calls++; return cancel(); };
  const response = new Response(body);
  assertError(await outcome(response), 502, 'Upstream did not return an event stream');
  assert.equal(calls, 1);
});

// A deadline in the parent must reap the owned process, not merely abandon a
// promise whose iterator can retain handles. Never capture child output or echo IPC.
async function childScenario(mode, launch = spawn, limits = {ready:15000, valid:5000, hang:400, close:5000}) {
  const child = launch(process.execPath, [fileURLToPath(new URL('./inference-stream-child.mjs', import.meta.url)), mode], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {SystemRoot: process.env.SystemRoot || ''},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  let closed = false, error = false, ready = false, complete = false, invalid = false;
  let readyWake, eventWake, closeWake;
  const readiness = new Promise(resolve => { readyWake = resolve; });
  const event = new Promise(resolve => { eventWake = resolve; });
  const closure = new Promise(resolve => { closeWake = resolve; });
  // Retain the error guard even if close cannot be confirmed.
  child.on('error', () => { error = true; readyWake(); eventWake(); });
  child.on('message', message => {
    if (message === 'ready' && !ready) { ready = true; readyWake(); }
    else if (message === 'complete' && ready && !complete) { complete = true; eventWake(); }
    else { invalid = true; readyWake(); eventWake(); }
  });
  child.on('close', () => { closed = true; readyWake(); eventWake(); closeWake(); });
  async function bounded(promise, ms) {
    let timer;
    try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  let problem = '';
  try {
    await bounded(readiness, limits.ready);
    if (!ready || invalid || error || (closed && !complete)) problem = 'Child readiness failed';
    else {
      const signalled = await bounded(event, mode === 'valid' ? limits.valid : limits.hang);
      if (mode === 'valid') {
        if (!signalled || !complete || invalid || error) problem = 'Valid stream did not complete correctly';
      } else if (signalled || complete || invalid || error || closed) problem = 'Hang control did not remain active';
    }
  } finally {
    // A successful child must also close, including its IPC channel.
    if (!problem && mode === 'valid' && !await bounded(closure, limits.close)) problem = 'Valid stream child did not close';
    if (!closed) {
      try { if (!child.kill()) problem ||= 'Child termination failed'; } catch { problem ||= 'Child termination failed'; }
      await bounded(closure, limits.close);
    }
    if (!closed) {
      problem = `Owned child close unconfirmed; pid=${Number.isSafeInteger(child.pid) ? child.pid : 'unknown'}`;
      try { if (child.connected) child.disconnect(); } catch {}
      child.unref();
    } else if (!problem && mode === 'valid' && (child.exitCode !== 0 || child.signalCode !== null)) {
      problem = 'Valid stream child did not exit cleanly';
    }
  }
  if (problem) throw new SafeChildError(problem);
}

test('mixed-case event-stream content type accepts and parses valid stream', async () => {
  await childScenario('valid');
});

test('owned process deadline reaps an uncooperative live-handle iterator', async () => {
  await childScenario('hang-control');
});

test('unconfirmed close is reported and a late child error is guarded', async () => {
  const fake = new EventEmitter();
  fake.pid = 123;
  fake.connected = true;
  let killed = false, disconnected = false, unrefed = false;
  fake.kill = () => { killed = true; return true; };
  fake.disconnect = () => { disconnected = true; fake.connected = false; };
  fake.unref = () => { unrefed = true; };
  const launch = () => { setImmediate(() => fake.emit('message', 'ready')); return fake; };
  let observed = false;
  try { await childScenario('hang-control', launch, {ready:1000, valid:10, hang:10, close:10}); }
  catch (error) { observed = error instanceof SafeChildError && error.message === 'Owned child close unconfirmed; pid=123'; }
  assert.equal(observed && killed && disconnected && unrefed, true, 'unconfirmed child must fail and release owned handles');
  fake.emit('error', new Error('synthetic late child error'));
});

test('secret assertions reject contaminated diagnostics without printing markers', () => {
  for (const secret of [bodySecret, auth.token]) {
    for (const [field, expected] of [
      ['message', 'error message must not expose secrets'],
      ['serialized', 'error must not expose secrets'],
      ['stack', 'stack must not expose secrets'],
      ['text', 'error text must not expose secrets'],
    ]) {
      const error = new UpstreamError(502, 'Upstream did not return an event stream');
      if (field === 'message') error.message = secret;
      if (field === 'serialized') error.extra = secret;
      if (field === 'stack') error.stack = secret;
      if (field === 'text') error.toString = () => secret;
      let failed = false, safe = false, expectedStage = false;
      try { assertError({kind:'rejected', error}, 502, 'Upstream did not return an event stream'); }
      catch (failure) {
        failed = true;
        safe = safeCheck(() => !String(failure).includes(secret) && !JSON.stringify(failure).includes(secret) && !String(failure.stack).includes(secret));
        expectedStage = safeCheck(() => failure.message.startsWith(expected));
      }

      assert.equal(failed, true, 'contaminated diagnostic must fail');
      assert.equal(safe, true, 'assertion failure must not expose marker');
      assert.equal(expectedStage, true, 'contaminated field must fail its own secret check');
    }
  }
});

test('HTTP error retains status when cancellation throws without exposing body', async () => {
  const body = secretBody();
  let calls = 0;
  body.cancel = () => { calls++; throw new Error('synthetic synchronous cancellation failure'); };
  const response = new Response(body, {status:503, headers:{'content-type':'application/json'}});
  assertError(await outcome(response), 503, 'Upstream returned HTTP 503');
  assert.equal(calls, 1);
  assert.equal(response.bodyUsed, false);
});
