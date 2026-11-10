import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inspect } from 'node:util';
import ts from 'typescript';

// Never let unexpected fixture errors or assertion diagnostics print secrets.
const test = (name, run) => nodeTest(name, { timeout: 5000 }, async () => {
  try { await run(); } catch { throw new Error('OAuth fixture failed'); }
});

// No application imports, real process environment, sockets, or credentials.
const source = readFileSync(new URL('../src/upstream/oauth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
// Observe immediately without changing the promise or its eventual outcome.
const guard = promise => { promise.catch(() => {}); return promise; };
const deferred = () => { let resolve, reject; const promise = guard(new Promise((a, b) => { resolve = a; reject = b; })); return { promise, resolve, reject }; };
const deadline = async (promise, ms = 1000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
};
const turn = () => deadline(guard(new Promise(resolve => setImmediate(resolve))));

async function cleanup(oauth, finish, stop, { stopMayReject = false, ms = 1000 } = {}) {
  // Start both paths before waiting: a stalled completion cannot prevent stop.
  const pending = [];
  if (finish) pending.push(deadline(finish.then(() => undefined, () => undefined), ms));
  try {
    const stopping = stop ?? guard(oauth.stopOAuth());
    pending.push(deadline(stopMayReject ? stopping.then(() => undefined, () => undefined) : stopping, ms));
  } catch { pending.push(Promise.reject(new Error('fixture cleanup failed'))); }
  const results = await Promise.allSettled(pending);
  if (results.some(result => result.status === 'rejected')) throw new Error('fixture cleanup failed');
}

function fixture(fetch, abortThrows = false, hooks = {}) {
  class Controller extends AbortController {
    abort() { super.abort(); if (abortThrows) throw new Error('synthetic abort failure'); }
  }
  const log = (...args) => { hooks.logs?.push(args); };
  const fakeCrypto = {
    randomBytes: n => Buffer.alloc(n, 7),
    randomUUID: () => 'synthetic-flow',
    createHash: () => ({ update: () => ({ digest: () => Buffer.alloc(32, 8) }) }),
  };
  const logger = { info: log, warn: log, error: log, debug: log, trace: log, fatal: log };
  logger.child = (...args) => { log(...args); return logger; };
  const dependencies = Object.assign(Object.create(null), {
    crypto: { default: fakeCrypto, __esModule: true },
    http: { default: { createServer() { throw new Error('listener forbidden'); } }, __esModule: true },
    '../utils/logger.js': { logger },
  });
  const exports = {};
  const sandbox = { exports, process: { env: Object.create(null) }, Buffer, URL, URLSearchParams,
    AbortController: Controller, AbortSignal: hooks.AbortSignal ?? AbortSignal, fetch,
    console: { log, info: log, warn: log, error: log, debug: log, trace: log },
    Date: class extends Date { static now() { return hooks.now ? hooks.now() : 1700000000000; } },
    setTimeout: () => ({ unref() {} }),
    require(name) { if (!Object.hasOwn(dependencies, name)) throw new Error('unexpected import'); return dependencies[name]; },
  };
  vm.runInNewContext(`${compiled}\nexports.__complete = completeFlow; exports.__flows = flows;`, sandbox, { timeout: 1000, filename: 'synthetic-oauth.js' });
  for (const name of ['startLogin', 'finishLogin', 'stopOAuth', '__complete']) {
    const original = exports[name];
    exports[name] = (...args) => guard(original(...args));
  }
  return exports;
}

async function start(oauth) {
  const flow = await deadline(oauth.startLogin('anthropic', { name: 'synthetic' }));
  return { id: flow.flowId, input: `synthetic-code#${new URL(flow.authUrl).searchParams.get('state')}` };
}
const fixedError = '로그인을 완료하지 못했습니다. 다시 시도해주세요.';

for (const stage of ['initial', 'initial-and-final', 'final-success', 'final-failure']) {
  test(`clock failure at ${stage} never leaks or masks the committed outcome`, async () => {
    const logs = [], secret = 'synthetic-clock-secret-7b92';
    let armed = false, samples = 0, callbacks = 0, fetches = 0;
    const oauth = fixture(() => {
      fetches++;
      if (stage === 'final-failure') throw new Error(secret);
      return Promise.resolve(fetches === 1 ? okResponse(async () => tokenBody) : { ok: false });
    }, false, { logs, now() {
      if (armed && (++samples === 1 && (stage === 'initial' || stage === 'initial-and-final') || samples === 2 && stage === 'initial-and-final' || samples === 3 && stage === 'final-success' || samples === 2 && stage === 'final-failure')) throw new Error(secret);
      return 1700000000000;
    } });
    oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
    try {
      const flow = await start(oauth);
      armed = true;
      const result = await deadline(oauth.__complete(oauth.__flows.get(flow.id), 'synthetic-code').then(() => ({ ok: true }), error => ({ ok: false, error })));
      const visible = oauth.__flows.get(flow.id);
      const text = inspect({ error: result.error, visible: { status: visible.status, error: visible.error }, logs }, { depth: 10 });
      assert.equal(text.includes(secret), false, 'clock and provider secrets must not leak');
      assert.equal(text.includes('synthetic-code'), false, 'authorization code must not leak');
      if (stage === 'final-success') {
        assert.equal(result.ok, true, 'successful account write remains successful');
        assert.equal(callbacks, 1); assert.equal(visible.status, 'done');
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.error?.message === fixedError, true, 'fixed public failure');
        assert.equal(callbacks, 0);
      }
    } finally { armed = false; await deadline(oauth.stopOAuth()); }
  });
}

test('public initial cleanup clock failure is sanitized', async () => {
  let armed = false, calls = 0; const logs = [];
  const oauth = fixture(() => { calls++; throw new Error('unexpected'); }, false, {
    logs, now() { if (armed) throw new Error('synthetic-clock-secret'); return 1700000000000; },
  });
  try {
    const flow = await start(oauth); armed = true;
    const result = await deadline(oauth.finishLogin(flow.id, flow.input).then(() => null, error => error));
    assert.equal(result?.message === fixedError, true, 'fixed failure');
    assert.equal(inspect({ result, logs }).includes('synthetic-clock-secret'), false);
    assert.equal(calls, 0);
  } finally { armed = false; await deadline(oauth.stopOAuth()); }
});

test('public completion preserves committed result when subsequent cleanup clock fails', async () => {
  let committed = false, clockFailures = 0; const logs = [];
  const oauth = fixture(url => url.endsWith('/v1/oauth/token')
    ? Promise.resolve(okResponse(async () => tokenBody)) : Promise.resolve({ ok: false }), false, {
    logs, now() { if (committed) { clockFailures++; throw new Error('synthetic-clock-secret'); } return 1700000000000; },
  });
  oauth.setOnLoginComplete(async () => { committed = true; return 'synthetic-account'; });
  try {
    const flow = await start(oauth);
    const outcome = await deadline(oauth.finishLogin(flow.id, flow.input).then(value => ({ value }), error => ({ error })));
    assert.equal(JSON.stringify(outcome.value) === JSON.stringify({ id: flow.id, provider: 'anthropic', status: 'done', accountId: 'synthetic-account' }), true, 'exact committed snapshot');
    assert.equal(Object.keys(outcome.value ?? {}).sort().join(',') === 'accountId,error,id,provider,status', true);
    assert.equal(clockFailures >= 1, true, 'post-callback cleanup was exercised');
    assert.equal(/synthetic-clock-secret|synthetic-token|synthetic-code/.test(inspect({ outcome, logs })), false);
  } finally { committed = false; await deadline(oauth.stopOAuth()); }
});

test('callback synchronously reenters stop and drains before committed completion', async () => {
  const ready = deferred(), gate = deferred(), logs = []; let finish, stop, stopped = false, calls = 0, writesAfterStop = 0;
  const oauth = fixture(url => url.endsWith('/v1/oauth/token')
    ? Promise.resolve(okResponse(async () => tokenBody)) : Promise.resolve({ ok: false }), false, { logs });
  oauth.setOnLoginComplete(() => {
    calls++;
    stop = oauth.stopOAuth();
    stop.then(() => { stopped = true; }, () => { stopped = true; });
    ready.resolve();
    return gate.promise.then(() => { if (stopped) writesAfterStop++; return 'synthetic-account'; });
  });
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    finish.catch(() => {});
    await deadline(ready.promise);
    assert.equal(Boolean(stop), true, 'callback initiated stop');
    assert.equal(oauth.__flows.size, 0);
    await turn(); assert.equal(stopped, false, 'stop waits for callback');
    gate.resolve();
    const result = await deadline(finish);
    await deadline(stop);
    assert.equal(JSON.stringify(result) === JSON.stringify({ id: flow.id, provider: 'anthropic', status: 'done', accountId: 'synthetic-account' }), true, 'exact committed snapshot');
    assert.equal(Object.keys(result ?? {}).sort().join(',') === 'accountId,error,id,provider,status', true);
    assert.equal(/synthetic-token|synthetic-code/.test(inspect({ result, logs })), false);
    assert.equal(calls, 1); assert.equal(writesAfterStop, 0, 'no callback write after stop'); assert.equal(oauth.__flows.size, 0);
  } finally {
    gate.resolve(); if (finish) await deadline(finish.catch(() => {}));
    await deadline((stop ?? oauth.stopOAuth()).catch(() => {}));
  }
});

test('public validation retains fixed errors and pending state', async () => {
  let calls = 0; const logs = [];
  const oauth = fixture(() => { calls++; throw new Error('unexpected'); }, false, { logs });
  try {
    const flow = await start(oauth);
    const errorFor = async (id, input) => deadline(oauth.finishLogin(id, input).then(() => null, error => error));
    assert.equal((await errorFor('missing', flow.input))?.message === '로그인 세션이 만료되었거나 없습니다. 처음부터 다시 시도해주세요.', true);
    const malformed = await errorFor(flow.id, 'http://[synthetic-url-secret');
    assert.equal(malformed?.message === '잘못된 콜백 URL입니다.', true);
    assert.equal(inspect({ malformed, logs }).includes('synthetic-url-secret'), false);
    assert.equal((await errorFor(flow.id, 'http://example.invalid/?code=x'))?.message === '잘못된 콜백 URL입니다.', true);
    assert.equal((await errorFor(flow.id, ''))?.message === '코드를 찾지 못했습니다.', true);
    assert.equal((await errorFor(flow.id, 'synthetic-code#wrong'))?.message === 'state 값이 일치하지 않습니다. 이 로그인 세션에서 받은 코드인지 확인해주세요.', true);
    assert.equal(oauth.getFlow(flow.id).status, 'pending');
    oauth.__flows.get(flow.id).status = 'done';
    assert.equal((await errorFor(flow.id, flow.input))?.message === '로그인 세션이 이미 사용 중이거나 종료되었습니다.', true);
    assert.equal(calls, 0);
  } finally { await deadline(oauth.stopOAuth()); }
});

const tokenBody = JSON.stringify({ access_token: 'synthetic-token' });
const okResponse = text => ({ ok: true, status: 200, text });

test('already-aborted signal is supplied to token fetch and rejection is sanitized', async () => {
  const controller = new AbortController(); controller.abort();
  let observed, calls = 0, callbacks = 0;
  const oauth = fixture((_url, options) => {
    calls++; observed = options.signal.aborted;
    return Promise.reject(new Error('synthetic aborted provider secret'));
  }, false, { AbortSignal: { any: () => controller.signal, timeout: () => controller.signal } });
  oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
  try {
    const flow = await start(oauth);
    const outcome = await deadline(oauth.finishLogin(flow.id, flow.input).then(() => null, e => e.message));
    assert.equal(observed, true); assert.equal(calls, 1); assert.equal(callbacks, 0);
    assert.equal(outcome === fixedError, true);
  } finally { await deadline(oauth.stopOAuth()); }
});

test('stop aborts an already-started bootstrap and drains until it settles', async () => {
  const bootstrap = deferred(), ready = deferred();
  let signal, finish, stop, stopped = false, callbacks = 0, calls = 0;
  const oauth = fixture((url, options) => {
    calls++;
    if (url.endsWith('/v1/oauth/token')) return Promise.resolve(okResponse(async () => tokenBody));
    signal = options.signal; ready.resolve(); return bootstrap.promise;
  });
  oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    const outcome = finish.then(() => 'resolved', () => 'rejected');
    await deadline(ready.promise);
    assert.equal(signal.aborted, false);
    stop = oauth.stopOAuth(); stop.then(() => { stopped = true; }, () => { stopped = true; });
    assert.equal(signal.aborted, true);
    await turn(); assert.equal(stopped, false);
    bootstrap.resolve({ ok: true, json: async () => ({ oauth_account: { account_email: 'synthetic@example.invalid' } }) });
    assert.equal(await deadline(outcome), 'rejected');
    await deadline(stop); assert.equal(callbacks, 0); assert.equal(calls, 2);
  } finally {
    bootstrap.resolve({ ok: false });
    if (finish) await deadline(finish.catch(() => {}));
    await deadline((stop ?? oauth.stopOAuth()).catch(() => {}));
  }
});

test('successful bootstrap supplies parsed metadata and credentials to callback', async () => {
  let received, calls = 0;
  const oauth = fixture(url => {
    calls++;
    if (url.endsWith('/v1/oauth/token')) return Promise.resolve(okResponse(async () => JSON.stringify({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 60, account: { email_address: 'fallback@example.invalid' } })));
    return Promise.resolve({ ok: true, json: async () => ({ oauth_account: { account_email: 'synthetic@example.invalid', organization_rate_limit_tier: 'synthetic-plan' } }) });
  });
  oauth.setOnLoginComplete(async (_flow, parsed) => { received = JSON.parse(JSON.stringify(parsed)); return 'synthetic-account'; });
  try {
    const flow = await start(oauth);
    const result = await deadline(oauth.finishLogin(flow.id, flow.input));
    assert.equal(result.status, 'done'); assert.equal(result.accountId, 'synthetic-account'); assert.equal(calls, 2);
    assert.equal(received?.credentialType === 'oauth', true, 'credential type');
    assert.equal(received?.credentials === JSON.stringify({ kind: 'oauth', accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresAt: 1700000060000 }), true, 'exact credentials');
    assert.equal(JSON.stringify(received?.meta) === JSON.stringify({ source: 'oauth_login', email: 'synthetic@example.invalid', plan: 'synthetic-plan', expiresAt: 1700000060000, hasRefreshToken: true }), true, 'exact metadata');
    assert.equal(Object.keys(received ?? {}).sort().join(',') === 'credentialType,credentials,meta', true, 'exact callback fields');
  } finally { await deadline(oauth.stopOAuth()); }
});

test('invalid complete session retains the existing public error', async () => {
  const oauth = fixture(() => { throw new Error('unexpected fetch'); });
  try {
    const flow = await start(oauth);
    const stored = oauth.__flows.get(flow.id); stored.status = 'done';
    const message = await deadline(oauth.__complete(stored, 'synthetic-code').then(() => null, e => e.message));
    assert.equal(message === '로그인 세션이 만료되었거나 이미 사용되었습니다.', true);
    assert.equal(stored.status, 'done');
  } finally { await deadline(oauth.stopOAuth()); }
});

test('reentrant stop owns the accepted exchange through response body and completion', async () => {
  const headers = deferred(), body = deferred();
  let oauth, stop, signal, abortEvents = 0, tokenCalls = 0, bootstrapCalls = 0, callbacks = 0, stopped = false;
  const onAbort = () => { abortEvents++; };
  oauth = fixture((url, options) => {
    if (url.endsWith('/v1/oauth/token')) { tokenCalls++; signal = options.signal; signal.addEventListener('abort', onAbort); stop = oauth.stopOAuth(); stop.then(() => { stopped = true; }, () => { stopped = true; }); return headers.promise; }
    bootstrapCalls++; return Promise.resolve({ ok: false });
  });
  oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
  let finish;
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    const outcome = finish.then(() => 'resolved', () => 'rejected');
    assert.equal(tokenCalls, 1);
    assert.ok(stop);
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, true);
    assert.equal(abortEvents, 1);
    await turn();
    assert.equal(stopped, false, 'stop must wait for the pending provider exchange');
    headers.resolve(okResponse(() => body.promise));
    await turn();
    assert.equal(stopped, false, 'stop must wait for the pending provider response body');
    body.resolve(tokenBody);
    assert.equal(await deadline(outcome), 'rejected');
    await deadline(stop);
    assert.equal(callbacks, 0);
    assert.equal(tokenCalls, 1);
    assert.equal(bootstrapCalls, 0, 'shutdown must prevent a new bootstrap request');
  } finally {
    headers.resolve(okResponse(async () => tokenBody)); body.resolve(tokenBody);
    signal?.removeEventListener('abort', onAbort);
    if (finish) await deadline(finish.catch(() => {}));
    if (stop) await deadline(stop.catch(() => {}));
  }
});

test('successful non-shutdown flow waits for account callback', async () => {
  const callback = deferred(); let calls = 0, tokenCalls = 0, bootstrapCalls = 0;
  const oauth = fixture(url => {
    if (url.endsWith('/v1/oauth/token')) { tokenCalls++; return Promise.resolve(okResponse(async () => tokenBody)); }
    bootstrapCalls++; return Promise.resolve({ ok: false });
  });
  oauth.setOnLoginComplete(() => { calls++; return callback.promise; });
  let finish;
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    await turn();
    assert.equal(calls, 1);
    assert.equal(oauth.getFlow(flow.id).status, 'processing');
    callback.resolve('synthetic-account');
    const result = await deadline(finish);
    assert.equal(result.status, 'done');
    assert.equal(result.accountId, 'synthetic-account');
    assert.equal(tokenCalls, 1); assert.equal(bootstrapCalls, 1);
  } finally { callback.resolve('synthetic-account'); if (finish) await deadline(finish.catch(() => {})); await deadline(oauth.stopOAuth()); }
});

test('stop waits for an already-started account callback', async () => {
  const callback = deferred(); let oauth, finish, stop, stopped = false, calls = 0;
  oauth = fixture(url => url.endsWith('/v1/oauth/token')
    ? Promise.resolve(okResponse(async () => tokenBody)) : Promise.resolve({ ok: false }));
  oauth.setOnLoginComplete(() => { calls++; return callback.promise; });
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    await turn();
    assert.equal(calls, 1);
    stop = oauth.stopOAuth();
    stop.then(() => { stopped = true; }, () => { stopped = true; });
    await turn();
    assert.equal(stopped, false, 'stop must wait for the pending account callback');
    callback.resolve('synthetic-account');
    await deadline(finish);
    await deadline(stop);
    assert.equal(calls, 1);
  } finally {
    callback.resolve('synthetic-account');
    if (finish) await deadline(finish.catch(() => {}));
    if (stop) await deadline(stop.catch(() => {}));
  }
});

for (const mode of ['throw', 'reject']) {
  test(`falsey fetch ${mode} after reentrant stop is handled`, async () => {
    let oauth, stop, calls = 0, callbacks = 0;
    oauth = fixture(() => { calls++; stop = oauth.stopOAuth(); if (mode === 'throw') throw undefined; return Promise.reject(null); });
    oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
    const flow = await start(oauth);
    const result = oauth.finishLogin(flow.id, flow.input).then(() => 'resolved', () => 'rejected');
    assert.equal(await deadline(result), 'rejected');
    await deadline(stop);
    assert.equal(calls, 1); assert.equal(callbacks, 0);
  });
}

test('failed reentrant stop and failed completion have no unhandled rejection', async () => {
  let oauth, stop; const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    oauth = fixture(() => { stop = oauth.stopOAuth(); return Promise.reject(false); }, true);
    const flow = await start(oauth);
    const finish = oauth.finishLogin(flow.id, flow.input);
    assert.equal(await deadline(finish.then(() => 'resolved', () => 'rejected')), 'rejected');
    assert.equal(await deadline(stop.then(() => 'resolved', () => 'rejected')), 'rejected');
    await turn(); await turn();
    assert.equal(unhandled.length, 0);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('cleanup reentry stops an already-published completion before provider dispatch', async () => {
  let oauth, stop, finish, calls = 0, clockCalls = 0, armed = false, settled = false;

  oauth = fixture(() => { calls++; throw new Error('unexpected fetch'); }, false, {
    now() {
      if (armed && ++clockCalls === 2) {
        stop = oauth.stopOAuth();
        stop.then(() => { settled = true; }, () => { settled = true; });
        assert.equal(settled, false);
      }
      return 1700000000000;
    },
  });
  try {
    const flow = await start(oauth);
    armed = true;
    finish = oauth.finishLogin(flow.id, flow.input);
    const outcome = finish.then(() => 'resolved', () => 'rejected');
    assert.ok(stop);
    assert.equal(await deadline(outcome), 'rejected');
    await deadline(stop);
    assert.equal(calls, 0);
    assert.equal(settled, true, 'stop eventually settles');
  } finally {
    if (finish) await deadline(finish.catch(() => {}));
    await deadline((stop ?? oauth.stopOAuth()).catch(() => {}));
  }
});

test('competing completions and TTL consume at most one exchange', async () => {
  let now = 1700000000000, tokenCalls = 0, bootstrapCalls = 0, callbacks = 0, finish;
  const headers = deferred();
  const oauth = fixture(url => {
    if (url.endsWith('/v1/oauth/token')) { tokenCalls++; return headers.promise; }
    bootstrapCalls++; return Promise.resolve({ ok: false });
  }, false, { now: () => now });
  oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    const first = finish.then(() => 'resolved', () => 'rejected');
    const second = oauth.finishLogin(flow.id, flow.input).then(() => 'resolved', () => 'rejected');
    assert.equal(await deadline(second), 'rejected');
    now += 600000;
    const expired = oauth.finishLogin(flow.id, flow.input).then(() => 'resolved', () => 'rejected');
    assert.equal(await deadline(expired), 'rejected');
    headers.resolve(okResponse(async () => tokenBody));
    assert.equal(await deadline(first), 'rejected');
    assert.equal(tokenCalls, 1); assert.equal(bootstrapCalls, 1); assert.equal(callbacks, 0);
  } finally {
    headers.resolve(okResponse(async () => tokenBody));
    if (finish) await deadline(finish.catch(() => {}));
    await deadline(oauth.stopOAuth());
  }
});

for (const mode of ['falsey', 'revoked']) {
  test(`provider ${mode} failure is sanitized for caller, flow and logs`, async () => {
    const logs = [];
    let calls = 0, callbacks = 0, finish, injected = false;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const oauth = fixture(() => {
      calls++;
      if (mode === 'falsey') { injected = true; throw undefined; }
      injected = true; throw revoked.proxy;
    }, false, { logs });
    oauth.setOnLoginComplete(async () => { callbacks++; return 'synthetic-account'; });
    try {
      const flow = await start(oauth);
      finish = oauth.finishLogin(flow.id, flow.input);
      const result = await deadline(finish.then(() => ({ failed: false }), error => ({ failed: true, error })));
      const visible = oauth.getFlow(flow.id);
      const output = inspect({ message: result.error?.message, stack: result.error?.stack, visible, logs }, { depth: 10 });
      assert.equal(result.failed, true, 'provider failure must reject');
      assert.equal(result.error?.message === '로그인을 완료하지 못했습니다. 다시 시도해주세요.', true, 'caller receives fixed error');
      assert.equal(visible?.status, 'error');
      assert.equal(visible?.error === '로그인을 완료하지 못했습니다. 다시 시도해주세요.', true);
      assert.equal(output.includes('synthetic-token'), false, 'token must not reach errors or logs');
      assert.equal(output.includes('synthetic-code'), false, 'authorization code must not reach errors or logs');
      assert.equal(injected, true, 'selected thrown value was injected');
      assert.equal(calls, 1); assert.equal(callbacks, 0);
    } finally {
      if (finish) await deadline(finish.catch(() => {}));
      await deadline(oauth.stopOAuth());
    }
  });
}

test('callback credential failure is sanitized after a best-effort bootstrap failure', async () => {
  const logs = []; let calls = 0, callbackCalls = 0, finish;
  const oauth = fixture(url => {
    calls++;
    if (url.endsWith('/v1/oauth/token')) return Promise.resolve(okResponse(async () => tokenBody));
    throw new Error('synthetic bootstrap failure');
  }, false, { logs });
  oauth.setOnLoginComplete(async (_flow, parsed) => {
    callbackCalls++;
    throw new Error(parsed.credentials);
  });
  try {
    const flow = await start(oauth);
    finish = oauth.finishLogin(flow.id, flow.input);
    const result = await deadline(finish.then(() => ({ failed: false }), error => ({ failed: true, error })));
    const output = inspect({ message: result.error?.message, stack: result.error?.stack, flow: oauth.getFlow(flow.id), logs }, { depth: 10 });
    assert.equal(result.failed, true);
    assert.equal(result.error?.message === '로그인을 완료하지 못했습니다. 다시 시도해주세요.', true);
    assert.equal(output.includes('synthetic-token'), false, 'token must not reach errors or logs');
    assert.equal(output.includes('synthetic-code'), false, 'code must not reach errors or logs');
    assert.equal(calls, 2); assert.equal(callbackCalls, 1);
  } finally {
    if (finish) await deadline(finish.catch(() => {}));
    await deadline(oauth.stopOAuth());
  }
});
