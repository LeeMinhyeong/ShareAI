import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';

const worker = fileURLToPath(new URL('./experimental-429-stopwatch-worker.mjs', import.meta.url));
const base = 9007199254740993000n;
function child(path) {
  const proc = fork(worker, [path], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','inherit','ipc'] });
  const queue = []; const waiters = [];
  let seq = 0;
  proc.on('message', m => {
    const i = waiters.findIndex(w => w.match(m));
    if (i < 0) queue.push(m); else { const w = waiters.splice(i,1)[0]; clearTimeout(w.timer); w.resolve(m); }
  });
  function receive(match, label = 'event') {
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i,1)[0]);
    return new Promise((resolve,reject) => {
      const w = { match, resolve, timer: setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) waiters.splice(j,1); reject(new Error(`worker message timeout: ${label}; queued=${JSON.stringify(queue)}`)); }, 5000) };
      waiters.push(w);
    });
  }
  const closed = new Promise(resolve => proc.once('close', (code, signal) => resolve({ code, signal })));
  async function call(cmd, extra = {}, raw = false) {
    const id = ++seq; const result = receive(m => m.id === id, cmd);
    proc.send({ ...extra, requestId: id, cmd });
    const msg = await result;
    if (raw) return msg;
    if (msg.error) throw new Error(msg.error);
    return msg.value;
  }
  async function stop() {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { await call('close'); } catch { proc.kill(); }
    }
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('worker did not close')), 5000).unref());
    try { await Promise.race([closed,timeout]); } catch (e) { proc.kill(); await Promise.race([closed, new Promise((_,reject) => setTimeout(() => reject(e),5000).unref())]); throw e; }
  }
  return { ready: () => receive(m => m.event === 'ready'), event: name => receive(m => m.event === name), call, stop };
}

test('independent observers, re-arm under writer lock, restart, and concurrent CAS', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || join(process.env.LOCALAPPDATA,'hermes','cache','scratch'), 'expiry-'));
  const path = join(dir,'fixture.sqlite');
  let db; const children = []; let reaped = false;
  try {
    db = new Database(path); db.pragma('journal_mode = WAL'); initialize(db);
    const a = child(path), b = child(path); children.push(a,b);
    await Promise.all([a.ready(),b.ready()]);
    const key = {kind:'codex',id:'same'};
    const old = await b.call('arm',{...key,duration:'10'});
    assert.equal(await a.call('check',key),'waiting');
    await a.call('now',{value:String(base+10n)});
    const newer = await b.call('holdRearm',{...key,duration:'10'});
    assert.notEqual(old,newer);
    const busy = a.event('writerBusy');
    const blocked = await a.call('check',{...key,trace:true},true);
    const busyEvent = await busy;
    assert.equal(blocked.code,'SQLITE_BUSY');
    assert.deepEqual(busyEvent.trace,blocked.trace);
    assert.deepEqual(blocked.trace,[{event:'read',inTransaction:false,row:{generation:old,duration:'10'}},{event:'beforeImmediate'},{event:'error',code:'SQLITE_BUSY',inTransaction:false}]);
    const selected = a.event('selected');
    const gateFile = join(dir,'release-selection');
    const attempt = a.call('check',{...key,gateFile,trace:true},true);
    assert.deepEqual((await selected).row,{generation:old,duration:'10'});
    await b.call('commit');
    writeFileSync(gateFile,'release');
    const result = await attempt;
    assert.equal(result.value,'waiting');
    assert.deepEqual(result.trace,[{event:'read',inTransaction:false,row:{generation:old,duration:'10'}},{event:'beforeImmediate'},{event:'read',inTransaction:true,row:{generation:newer,duration:'10'}},{event:'committed'}]);
    assert.deepEqual(db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get('codex','same'),{generation:newer,duration:'10'});
    // New generation restarts the full observation; unrelated colliding IDs remain distinct.
    await b.call('arm',{kind:'claude',id:'same',duration:'0'});
    assert.equal(await a.call('check',key),'waiting');
    await a.call('now',{value:String(base+19n)});
    assert.equal(await a.call('check',key),'waiting');
    await a.stop();
    const restarted = child(path); children.push(restarted); await restarted.ready();
    await restarted.call('now',{value:String(base+1000n)});
    assert.equal(await restarted.call('check',key),'waiting');
    await restarted.call('now',{value:String(base+1009n)});
    assert.equal(await restarted.call('check',key),'waiting');
    assert.equal(await b.call('check',key),'waiting');
    await b.call('now',{value:String(base+10n)});
    await restarted.call('now',{value:String(base+1010n)});
    const contenders = [restarted,b];
    const replies = await Promise.all(contenders.map(c => c.call('check',key,true)));
    const results = await Promise.all(replies.map((r,i) => {
      if (!r.error) return r.value;
      assert.equal(r.code,'SQLITE_BUSY');
      return contenders[i].call('check',key);
    }));
    assert.equal(results.filter(x => x === 'expired').length,1);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get('claude','same').n,1);
    assert.equal(await b.call('check',{kind:'claude',id:'same'}),'waiting');
    assert.equal(await b.call('check',{kind:'claude',id:'same'}),'expired');
  } finally {
    const results = await Promise.allSettled(children.map(c => c.stop()));
    reaped = results.every(r => r.status === 'fulfilled');
    if (db) db.close();
    if (reaped) rmSync(dir,{recursive:true,force:true});
    if (!reaped) throw new AggregateError(results.filter(r => r.status === 'rejected').map(r => r.reason),`workers not reaped; retained ${dir}`);
  }
});

test('SQLITE_BUSY preserves an unchanged generation observation through expiry', {timeout:30000}, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || join(process.env.LOCALAPPDATA,'hermes','cache','scratch'), 'expiry-busy-'));
  const path = join(dir,'fixture.sqlite'); let db; const children = [];
  try {
    db = new Database(path); db.pragma('journal_mode = WAL'); initialize(db);
    const observer = child(path), holder = child(path); children.push(observer,holder);
    await Promise.all([observer.ready(),holder.ready()]);
    const key = {kind:'codex',id:'busy-unchanged'};
    const generation = await holder.call('arm',{...key,duration:'10'});
    const row = {generation,duration:'10'};
    const snapshot = () => ({
      restrictions: db.prepare('SELECT * FROM experimental_429_restrictions').all(),
      generations: db.prepare('SELECT * FROM experimental_429_generations').all(),
    });
    const initial = snapshot();
    assert.deepEqual(initial.restrictions,[{kind:key.kind,account_id:key.id,...row}]);
    assert.deepEqual(initial.generations,[{generation}]);
    const observed = await observer.call('check',{...key,trace:true},true);
    assert.equal(observed.value,'waiting');
    assert.deepEqual(observed.trace,[{event:'read',inTransaction:false,row},{event:'clock',inTransaction:false}]);
    await observer.call('now',{value:String(base+4n)});
    await holder.call('hold');
    const busyEvent = observer.event('writerBusy');
    const blocked = await observer.call('check',{...key,trace:true},true);
    assert.equal(blocked.code,'SQLITE_BUSY');
    assert.deepEqual((await busyEvent).trace,blocked.trace);
    assert.deepEqual(blocked.trace,[{event:'read',inTransaction:false,row},{event:'beforeImmediate'},{event:'error',code:'SQLITE_BUSY',inTransaction:false}]);
    assert.deepEqual(snapshot(),initial);
    await holder.call('commit');
    assert.deepEqual(snapshot(),initial);
    await holder.call('hold');
    for (const elapsed of [9n,10n]) {
      await observer.call('now',{value:String(base+elapsed)});
      const busyEvent = observer.event('writerBusy');
      const blocked = await observer.call('check',{...key,trace:true},true);
      assert.equal(blocked.code,'SQLITE_BUSY');
      assert.deepEqual((await busyEvent).trace,blocked.trace);
      assert.deepEqual(blocked.trace,[{event:'read',inTransaction:false,row},{event:'beforeImmediate'},{event:'error',code:'SQLITE_BUSY',inTransaction:false}]);
      assert.deepEqual(snapshot(),initial);
    }
    await holder.call('commit');
    assert.deepEqual(snapshot(),initial);
    // Retry with the same observer and unchanged clock at the full duration.
    const expired = await observer.call('check',{...key,trace:true},true);
    assert.equal(expired.value,'expired');
    assert.deepEqual(expired.trace,[{event:'read',inTransaction:false,row},{event:'beforeImmediate'},{event:'read',inTransaction:true,row},{event:'clock',inTransaction:true},{event:'committed'}]);
    assert.deepEqual(snapshot(),{restrictions:[],generations:initial.generations});
  } finally {
    const results = await Promise.allSettled(children.map(c => c.stop()));
    if (db) db.close();
    if (results.every(r => r.status === 'fulfilled')) rmSync(dir,{recursive:true,force:true});
    else throw new AggregateError(results.filter(r => r.status === 'rejected').map(r => r.reason),`workers not reaped; retained ${dir}`);
  }
});

test('invalid durations fail closed, clocks cannot go backwards, and keys do not share observations', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = base; const s = new Stopwatch(db, () => now);
    for (const [i,bad] of [null, '-1', '1.5', 'NaN', '9223372036854775808', 10, '01'].entries()) {
      const id = `invalid-${i}`;
      arm(db,'a',id,bad); assert.equal(s.check('a',id),'waiting'); now += 100n; assert.equal(s.check('a',id),'waiting');
    }
    arm(db,'a','id','1'); assert.equal(s.check('a','id'),'waiting'); now -= 1n;
    assert.throws(() => s.check('a','id'),/monotonic/);
    arm(db,'b','id','1'); assert.equal(s.check('b','id'),'waiting');
    now += 1n; assert.equal(s.check('a','id'),'waiting');
    assert.equal(s.check('b','id'),'expired');
    now += 1n; assert.equal(s.check('a','id'),'expired');
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions').get().n,7);
  } finally { db.close(); }
});

test('actual arm retries after a competing writer commits longer, shorter, or indefinite duration', {timeout:30000}, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || join(process.env.LOCALAPPDATA,'hermes','cache','scratch'), 'arm-contention-'));
  const path = join(dir,'fixture.sqlite'); let db; const children = [];
  try {
    db = new Database(path); db.pragma('journal_mode = WAL'); initialize(db);
    const a = child(path), b = child(path); children.push(a,b); await Promise.all([a.ready(),b.ready()]);
    for (const duration of ['100',null,'2']) {
      const key = {kind:'codex',id:duration ?? 'indefinite'};
      const initial = await a.call('arm',{...key,duration:'1'});
      if (duration === '2') assert.equal(await a.call('check',key),'waiting');
      const gate = join(dir,`arm-gate-${key.id}`);
      const beforeWriter = a.event('beforeWriter');
      const pending = a.call('arm',{...key,duration:'5',trace:true,writerGateFile:gate},true);
      await beforeWriter;
      const held = await b.call('holdRearm',{...key,duration});
      const before = db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id);
      assert.deepEqual(before,{generation:initial,duration:'1'});
      const busy = a.event('writerBusy');
      writeFileSync(gate,'release');
      const blocked = await pending;
      assert.equal(blocked.code,'SQLITE_BUSY');
      assert.deepEqual((await busy).trace,blocked.trace);
      assert.deepEqual(blocked.trace,[{event:'beforeImmediate'},{event:'error',code:'SQLITE_BUSY',inTransaction:false}]);
      assert.deepEqual(db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id),before);
      await b.call('commit');
      assert.deepEqual(db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id),{generation:held,duration});
      if (duration === '2') await a.call('now',{value:String(base+1n)});
      const retried = await a.call('arm',{...key,duration:'5',trace:true},true);
      assert.ok(retried.value);
      assert.notEqual(retried.value,held);
      assert.notEqual(retried.value,initial);
      assert.deepEqual(retried.trace,[{event:'beforeImmediate'},{event:'read',inTransaction:true,row:{generation:held,duration}},{event:'committed'}]);
      const expectedDuration = duration === '2' ? '5' : duration;
      assert.deepEqual(db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id),{generation:retried.value,duration:expectedDuration});
      assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_generations WHERE generation IN (?,?)').get(held,retried.value).n,2);
      if (duration === '2') {
        assert.equal(await a.call('check',key),'waiting');
        await a.call('now',{value:String(base+5n)});
        assert.equal(await a.call('check',key),'waiting');
        assert.deepEqual(db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id),{generation:retried.value,duration:'5'});
        await a.call('now',{value:String(base+6n)});
        assert.equal(await a.call('check',key),'expired');
        assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id).n,0);
      }
    }
    const key = {kind:'codex',id:'100'};
    const row = db.prepare('SELECT * FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id);
    const count = db.prepare('SELECT count(*) n FROM experimental_429_generations').get().n;
    db.exec("CREATE TRIGGER reject_arm BEFORE UPDATE ON experimental_429_restrictions BEGIN SELECT RAISE(ABORT,'injected arm failure'); END");
    const failed = await a.call('arm',{...key,duration:'5',trace:true},true);
    assert.match(failed.error,/injected arm failure/);
    assert.deepEqual(failed.trace.at(-1),{event:'error',code:'SQLITE_CONSTRAINT_TRIGGER',inTransaction:false});
    assert.deepEqual(db.prepare('SELECT * FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id),row);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_generations').get().n,count);
    db.exec('DROP TRIGGER reject_arm');
    assert.ok(await a.call('arm',{...key,duration:'5'}));
  } finally {
    const results = await Promise.allSettled(children.map(c => c.stop()));
    if (db) db.close();
    if (results.every(r => r.status === 'fulfilled')) rmSync(dir,{recursive:true,force:true});
    else throw new AggregateError(results.filter(r => r.status === 'rejected').map(r => r.reason),`workers not reaped; retained ${dir}`);
  }
});

test('independent processes retain full overlap and sample after writer acquisition', {timeout:30000}, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || join(process.env.LOCALAPPDATA,'hermes','cache','scratch'), 'expiry-overlap-'));
  const path = join(dir,'fixture.sqlite'); let db; const children = [];
  try {
    db = new Database(path); db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 0'); initialize(db);
    const a = child(path), b = child(path); children.push(a,b); await Promise.all([a.ready(),b.ready()]);
    const key = {kind:'codex',id:'overlap'};
    const first = await b.call('arm',{...key,duration:'100'});
    assert.equal(await a.call('check',key),'waiting');
    await a.call('now',{value:String(base+90n)});
    const second = await b.call('arm',{...key,duration:'5'});
    assert.notEqual(first,second);
    assert.deepEqual(db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(key.kind,key.id),{generation:second,duration:'100'});
    assert.equal(await a.call('check',key),'waiting');
    await a.call('now',{value:String(base+189n)});
    assert.equal(await a.call('check',key),'waiting');
    await a.call('now',{value:String(base+190n)});
    await b.call('hold');
    assert.throws(() => db.exec('BEGIN IMMEDIATE'),/locked|busy/i);
    const busy = a.event('writerBusy');
    const blocked = await a.call('check',{...key,trace:true},true);
    assert.equal(blocked.code,'SQLITE_BUSY');
    assert.deepEqual((await busy).trace,blocked.trace);
    assert.deepEqual(blocked.trace,[{event:'read',inTransaction:false,row:{generation:second,duration:'100'}},{event:'beforeImmediate'},{event:'error',code:'SQLITE_BUSY',inTransaction:false}]);
    await b.call('commit');
    const retried = await a.call('check',{...key,trace:true},true);
    assert.equal(retried.value,'expired');
    assert.deepEqual(retried.trace,[{event:'read',inTransaction:false,row:{generation:second,duration:'100'}},{event:'beforeImmediate'},{event:'read',inTransaction:true,row:{generation:second,duration:'100'}},{event:'clock',inTransaction:true},{event:'committed'}]);
    const indefinite = {kind:'claude',id:'overlap'};
    await b.call('arm',{...indefinite,duration:null}); await b.call('arm',{...indefinite,duration:'1'});
    assert.equal(await a.call('check',indefinite),'waiting');
    await a.call('now',{value:String(base+10000n)});
    assert.equal(await a.call('check',indefinite),'waiting');
    assert.equal(db.prepare('SELECT duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(indefinite.kind,indefinite.id).duration,null);
  } finally {
    const results = await Promise.allSettled(children.map(c => c.stop()));
    if (db) db.close();
    if (results.every(r => r.status === 'fulfilled')) rmSync(dir,{recursive:true,force:true});
    else throw new AggregateError(results.filter(r => r.status === 'rejected').map(r => r.reason),`workers not reaped; retained ${dir}`);
  }
});
