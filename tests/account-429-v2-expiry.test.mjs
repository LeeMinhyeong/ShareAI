import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';

const sourcePath = new URL('../src/db/account-429-v2-expiry.ts', import.meta.url);
// The service now imports its database accessors (client, async writer, v2 store) instead of
// receiving them as options. Each load() gets a private module instance whose imports are wired to
// the readDb/write hooks of the service constructed from it, so the original fault injection stays.
const store = await import('../src/db/account-429-v2-store.ts');
function load() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const module = {exports: {}};
  const hooks = {};
  const imports = {
    './client.js': {requireInitializedDatabase: () => hooks.readDb()},
    './async-writer.js': {withAsyncWriter: (fn, options = {}) => hooks.write(fn, options)},
    './account-429-v2-store.js': {assert429V2Schema: store.assert429V2Schema},
  };
  const require = id => { if (!Object.hasOwn(imports, id)) throw new Error(`Unexpected import: ${id}`); return imports[id]; };
  vm.runInNewContext(js, {module, exports: module.exports, require, Promise, Error, TypeError, Number, BigInt, Map, Set, AbortController, Date, JSON});
  const Service = module.exports.Account429V2Expiry;
  return function Wired(dependencies) {
    hooks.readDb = dependencies.readDb; hooks.write = dependencies.write;
    return new Service(dependencies);
  };
}
function fixture(options = {}) {
  const db = new Database(':memory:');
  db.transaction(() => store.provision429V2(db)).immediate(); // the real v2 schema the service validates
  let now = 0n;
  const timers = new Map(); let seq = 0;
  const dependencies = {onFailure: () => {}, readDb: () => db, write: fn => db.transaction(() => fn(db)).immediate(), monotonic: () => now, setTimer: fn => { const id = ++seq; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id), intervalMs: 10, maxObservations: 10, scanBatch: 10, ...options};
  const service = new (load())(dependencies);
  const insert = (id, gen, duration, kind = 'upstream') => { db.prepare('UPDATE account_429_v2_counter SET generation=max(generation,?)').run(gen); db.prepare('INSERT OR REPLACE INTO account_429_v2_restrictions (kind, account_id, generation, duration_ms) VALUES(?,?,?,?)').run(kind,id,gen,duration); };
  const count = () => db.prepare('SELECT count(*) AS n FROM account_429_v2_restrictions').get().n;
  return {db, service, insert, count, setNow: n => {now = BigInt(n)}, timers};
}
test('full monotonic duration starts at first observation', async () => {
  const f = fixture();
  try { f.insert('a',1,10); await f.service.tick(); f.setNow(9999999); await f.service.tick(); assert.equal(f.count(),1); f.setNow(10000000); await f.service.tick(); assert.equal(f.count(),0); } finally { await f.service.stopAndDrain(); f.db.close(); }
});
test('generation change restarts shorter duration; null never expires', async () => {
  const f = fixture(); try {
    f.insert('a',1,100); f.insert('n',2,null,'siwc'); await f.service.tick();
    f.setNow(90000000); f.insert('a',3,10); await f.service.tick();
    f.setNow(99999999); await f.service.tick(); assert.equal(f.count(),2);
    f.setNow(100000000); await f.service.tick(); assert.equal(f.count(),1);
  } finally { await f.service.stopAndDrain(); f.db.close(); }
});
test('writer re-read defeats a rearm between scan and transaction', async () => {
  let f, changed = false;
  // Every tick now scans inside the writer, so rearm just before the writer of the tick that
  // would delete (the second one); the re-read under the writer must see the new generation.
  let writes = 0;
  f = fixture({write: fn => { if (++writes === 2 && !changed) { changed = true; f.insert('a',2,20); } return f.db.transaction(() => fn(f.db)).immediate(); }});
  try { f.insert('a',1,10); await f.service.tick(); f.setNow(10000000); await f.service.tick(); assert.equal(f.count(),1);
    await f.service.tick(); f.setNow(29999999); await f.service.tick(); assert.equal(f.count(),1);
    f.setNow(30000000); await f.service.tick(); assert.equal(f.count(),0);
  } finally { await f.service.stopAndDrain(); f.db.close(); }
});
test('new service instance waits again', async () => {
  const f = fixture(); try { f.insert('a',1,10); await f.service.tick(); f.setNow(9000000); await f.service.stopAndDrain();
    const NewService = load(); const replacement = new NewService({onFailure:()=>{}, readDb:()=>f.db, write: fn=>f.db.transaction(()=>fn(f.db)).immediate(), monotonic:()=>9000000n, setTimer:()=>0, clearTimer:()=>{}, intervalMs:1, maxObservations:1, scanBatch:1});
    await replacement.tick(); await replacement.tick(); assert.equal(f.count(),1); await replacement.stopAndDrain();
  } finally { f.db.close(); }
});
test('bounded keyset scan eventually expires more entries than capacity', async () => {
  const f = fixture({maxObservations: 2, scanBatch: 1}); try {
    for (let i=0;i<9;i++) f.insert(String(i),i+1,1);
    for (let i=0;i<60 && f.count();i++) { f.setNow(i*1000000); await f.service.tick(); }
    assert.equal(f.count(),0);
  } finally { await f.service.stopAndDrain(); f.db.close(); }
});
test('backwards clock fails closed and reports failure', async () => {
  const f = fixture(); try { f.insert('a',1,10); f.insert('b',2,10); f.setNow(100); await f.service.tick(); f.setNow(99);
    await assert.rejects(f.service.tick(), /Expiry tick failed/); assert.equal(f.count(),2);
    await assert.rejects(f.service.stopAndDrain(), /Expiry service failed/);
  } finally { f.db.close(); }
});
test('stop cancels timer, returns shared promise, blocks new work', async () => {
  let reads=0; const f = fixture({readDb:()=>{reads++; return f.db;}}); try {
    f.service.start(); assert.equal(f.timers.size,1);
    const a=f.service.stopAndDrain(); const b=f.service.stopAndDrain(); assert.equal(a,b); await a;
    assert.equal(f.timers.size,0); await assert.rejects(f.service.tick(), /unavailable/); assert.equal(reads,0);
  } finally { f.db.close(); }
});
test('stop drains pending writer and prevents its callback touching rows', async () => {
  let release, entered; const gate = new Promise(r=>{release=r}); const reached = new Promise(r=>{entered=r}); let f;
  let transactions=0;
  // The first tick's own writer observes the row; gate the second (deleting) tick's writer.
  let writes=0;
  f = fixture({write: async (fn,{signal})=>{ if (++writes===1) return f.db.transaction(()=>fn(f.db)).immediate(); entered(); await gate; signal.throwIfAborted(); transactions++; return f.db.transaction(()=>fn(f.db)).immediate(); }});
  try { f.insert('a',1,0); await f.service.tick(); const tick=f.service.tick(); await reached;
    let drained=false; const stop=f.service.stopAndDrain().then(()=>{drained=true}); await Promise.resolve(); assert.equal(drained,false);
    release(); await tick; await stop; assert.equal(f.count(),1); assert.equal(transactions,0);
  } finally { f.db.close(); }
});
test('clock is checked again under the writer transaction', async () => {
  // The scan now runs inside the writer, so the re-check is the second sample taken right before the
  // delete. Make the clock step backwards between the deciding sample and that locked re-check.
  let readings = null;
  const f = fixture({monotonic: () => readings && readings.length ? readings.shift() : 0n});
  try { f.insert('a',1,10); await f.service.tick(); readings = [10000000n, 0n]; await assert.rejects(f.service.tick(), /Expiry tick failed/); assert.equal(f.count(),1); await assert.rejects(f.service.stopAndDrain()); } finally { f.db.close(); }
});

test('wall clock changes do not advance monotonic observation', async () => {
  const original=Date.now; const f=fixture(); try { f.insert('a',1,10); await f.service.tick(); Date.now=()=>Number.MAX_SAFE_INTEGER; await f.service.tick(); assert.equal(f.count(),1); f.setNow(10000000); Date.now=()=>0; await f.service.tick(); assert.equal(f.count(),0); } finally { Date.now=original; await f.service.stopAndDrain(); f.db.close(); }
});
test('timer schedules serialized ticks at injected intervals', async () => {
  let callback; const delays=[]; let f;
  f=fixture({setTimer: (fn, ms)=>{callback=fn; delays.push(ms); return delays.length;}, clearTimer:()=>{}});
  try { f.insert('a',1,1); f.service.start(); assert.deepEqual(delays,[10]); callback(); await f.service.tick(); await new Promise(setImmediate);
    assert.deepEqual(delays,[10,10]); assert.equal(f.count(),1); f.setNow(1000000); callback(); await f.service.tick(); await new Promise(setImmediate); assert.equal(f.count(),0);
  } finally { await f.service.stopAndDrain(); f.db.close(); }
});
test('corrupt values fail closed without raw errors', async () => {
  const f=fixture(); try { f.insert('sensitive-value',1,1); f.db.pragma('ignore_check_constraints = ON'); f.db.prepare('UPDATE account_429_v2_restrictions SET duration_ms=?').run(9007199254740992n);
    await assert.rejects(f.service.tick(), e=>e.message === 'Expiry tick failed' && !String(e.stack).includes('sensitive-value'));
    assert.equal(f.count(),1); await assert.rejects(f.service.stopAndDrain());
  } finally { f.db.close(); }
});
