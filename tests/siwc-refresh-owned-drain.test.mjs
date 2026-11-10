import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(clock) {
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const path = new URL(name === 'work' ? '../src/request-work.ts' : '../src/upstream/siwc-refresh.ts', import.meta.url);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    const sandbox = { module, exports: module.exports, require: (id) => id === '../request-work.js' ? load('work') : id === './siwc-store.js' || id === 'jose' ? {} : require(id), Promise, Error, Date: clock?.Date ?? Date, AbortController, AbortSignal, URLSearchParams, setTimeout: clock?.setTimeout ?? setTimeout, clearTimeout: clock?.clearTimeout ?? clearTimeout };
    vm.runInNewContext(code, sandbox, { filename: name });
    modules.set(name, module.exports);
    return module.exports;
  }
  return { ...load('work'), ...load('refresh') };
}
const snapshot = { revision: 'old', credential: { clientId: 'client', refreshToken: 'old-token', accessToken: 'old-access', expiresIn: 3600, savedAt: new Date().toISOString(), scopes: [] } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeClock() {
  let now = Date.now(), next = 1;
  const timers = new Map();
  return {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setTimeout(fn, delay) { const id = next++; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    get count() { return timers.size; },
  };
}
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline')), 2000); })]); } finally { clearTimeout(timer); } }
function fixture() {
  const claim = deferred(), entered = deferred(), provider = deferred(), called = deferred(), finish = deferred(), finishing = deferred();
  let state = snapshot, calls = 0, finishes = 0;
  const intent = { credential: snapshot.credential, fence: 'owned' };
  const store = { db: {}, refreshConnection() { return { store: this, close() {} }; }, claimRefresh() { entered.resolve(); return claim.promise; }, readSnapshot() { return state; }, finishRefresh(id, actual, credential) { assert.equal(actual, intent); finishing.resolve(); return finish.promise.then(() => { finishes++; state = { revision: 'new', credential }; return state; }); } };
  const fetcher = () => { calls++; called.resolve(); return provider.promise; };
  const reply = { status: 200, json: async () => ({ access_token: 'new-access', refresh_token: 'new-token', token_type: 'Bearer', expires_in: 3600 }) };
  return { claim, entered, provider, called, finish, finishing, store, fetcher, reply, intent, get calls() { return calls; }, get finishes() { return finishes; } };
}
test('admitted refresh retains post-stop ownership through provider and fenced persistence', async () => {
  const { requestWork, refreshSiwcSnapshot } = setup();
  const f = fixture();
  let drained = false;
  const result = refreshSiwcSnapshot(f.store, 'account', snapshot, f.fetcher, 5000);
  const handled = result.then(value => ({ value }), error => ({ error }));
  try {
    await bounded(f.entered.promise);
    const drain = requestWork.stopAndDrain().then(() => { drained = true; });
    assert.equal(requestWork.run(() => 1), undefined);
    const rejected = refreshSiwcSnapshot(f.store, 'other', snapshot, f.fetcher, 5000);
    await assert.rejects(rejected, /reauthorization required/);
    f.claim.resolve(f.intent);
    await bounded(Promise.race([f.called.promise, handled.then(() => { throw new Error('flight settled before provider'); })]));
    assert.equal(f.calls, 1);
    await tick(); assert.equal(drained, false);
    f.provider.resolve(f.reply);
    await bounded(f.finishing.promise);
    await tick(); assert.equal(drained, false);
    f.finish.resolve();
    const outcome = await bounded(handled);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.value.revision, 'new');
    await bounded(drain);
    assert.equal(f.finishes, 1);
  } finally { f.claim.resolve(f.intent); f.provider.resolve(f.reply); f.finish.resolve(); await bounded(handled); }
});

test('successful coalescing and reentrant claim publish one flight before invocation', async () => {
  const { requestWork, refreshSiwcSnapshot } = setup();
  const f = fixture();
  const original = f.store.claimRefresh;
  let second;
  f.store.claimRefresh = function (...args) { second = refreshSiwcSnapshot(f.store, 'account', snapshot, f.fetcher, 5000); return original.apply(this, args); };
  const first = refreshSiwcSnapshot(f.store, 'account', snapshot, f.fetcher, 5000);
  try {
    await bounded(f.entered.promise);
    f.claim.resolve(f.intent); await bounded(f.called.promise);
    f.provider.resolve(f.reply); await bounded(f.finishing.promise); f.finish.resolve();
    const results = await bounded(Promise.all([first, second]));
    assert.equal(results[0].revision, 'new'); assert.equal(results[1].revision, 'new');
    assert.equal(f.calls, 1); assert.equal(f.finishes, 1);
    await bounded(requestWork.stopAndDrain());
  } finally { f.claim.resolve(f.intent); f.provider.resolve(f.reply); f.finish.resolve(); await Promise.allSettled([first, second]); }
});

test('late provider after flight timeout remains owned until fenced persistence', async () => {
  const clock = fakeClock();
  const { requestWork, refreshSiwcSnapshot } = setup(clock);
  const f = fixture();
  let drained = false, inherited;
  const fetcher = (...args) => { inherited = Promise.resolve().then(() => requestWork.run(() => 1)); return f.fetcher(...args); };
  const result = refreshSiwcSnapshot(f.store, 'account', snapshot, fetcher, 60000);
  const handled = result.then(value => ({ value }), error => ({ error }));
  try {
    await bounded(f.entered.promise);
    const drain = requestWork.stopAndDrain().then(() => { drained = true; });
    f.claim.resolve(f.intent); await bounded(f.called.promise);
    assert.equal(await inherited, undefined);
    clock.advance(15000);
    const outcome = await bounded(handled);
    assert.match(outcome.error.message, /reauthorization required/);
    await tick(); assert.equal(drained, false);
    f.provider.resolve(f.reply); await bounded(f.finishing.promise);
    await tick(); assert.equal(drained, false);
    f.finish.resolve(); await bounded(drain);
    assert.equal(f.calls, 1); assert.equal(f.finishes, 1); assert.equal(clock.count, 0);
  } finally { f.claim.resolve(f.intent); f.provider.resolve(f.reply); f.finish.resolve(); await bounded(handled); }
});

test('last waiter cancellation after claim does not dispatch or release claim', async () => {
  const { requestWork, refreshSiwcSnapshot } = setup();
  const f = fixture(), controller = new AbortController();
  const result = refreshSiwcSnapshot(f.store, 'account', snapshot, f.fetcher, 5000, controller.signal);
  const handled = result.then(value => ({ value }), error => ({ error }));
  try {
    await bounded(f.entered.promise);
    const drain = requestWork.stopAndDrain();
    controller.abort(new Error('cancelled')); await bounded(handled);
    f.claim.resolve(f.intent); await bounded(drain);
    assert.equal(f.calls, 0); assert.equal(f.finishes, 0);
  } finally { f.claim.resolve(f.intent); f.provider.resolve(f.reply); f.finish.resolve(); await bounded(handled); }
});

test('falsey claim failure releases flight ownership', async () => {
  const { requestWork, refreshSiwcSnapshot } = setup();
  const f = fixture();
  f.store.claimRefresh = () => { throw undefined; };
  const result = refreshSiwcSnapshot(f.store, 'account', snapshot, f.fetcher, 5000);
  const observed = result.then(() => false, () => true);
  assert.equal(await bounded(observed), true);
  await bounded(requestWork.stopAndDrain());
  assert.equal(f.calls, 0);
});
