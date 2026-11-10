import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initialize, arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';

test('indefinite dominates finite overlap, and generations survive rollback', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const s = new Stopwatch(db, () => now);
    const a = arm(db,'k','a',null); const b = arm(db,'k','a','1');
    assert.notEqual(a,b); assert.equal(db.prepare('SELECT duration FROM experimental_429_restrictions').get().duration,null);
    assert.equal(s.check('k','a'),'waiting'); now = 100n; assert.equal(s.check('k','a'),'waiting');
    db.exec("CREATE TRIGGER reject_arm BEFORE UPDATE ON experimental_429_restrictions BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => arm(db,'k','a','3'),/injected/);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_generations').get().n,2);
    assert.equal(db.prepare('SELECT generation FROM experimental_429_restrictions').get().generation,b);
  } finally { db.close(); }
});

test('autocommit is mandatory, including savepoints, and clock errors rollback', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 10n; const s = new Stopwatch(db, () => now);
    arm(db,'k','a','1'); assert.equal(s.check('k','a'),'waiting');
    db.exec('SAVEPOINT outer');
    assert.throws(() => s.check('k','a'),/autocommit/);
    assert.throws(() => s.checkMany([{kind:'k',id:'a'}],1),/autocommit/);
    assert.throws(() => arm(db,'k','a','5'),/autocommit/);
    db.exec('ROLLBACK TO outer; RELEASE outer');
    now = 9n; assert.throws(() => s.check('k','a'),/monotonic/);
    assert.equal(db.inTransaction,false);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions').get().n,1);
    now = 100n; assert.equal(s.check('k','a'),'waiting'); now++; assert.equal(s.check('k','a'),'expired');
  } finally { db.close(); }
});

test('bounded round-robin ticks progress with absent candidates and independent timers', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const s = new Stopwatch(db, () => now, 3);
    const keys = [{kind:'a',id:'x'}, {kind:'missing',id:'x'}, {kind:'b',id:'x'}, {kind:'a',id:'y'}];
    for (const key of [keys[0],keys[2],keys[3]]) arm(db,key.kind,key.id,'5');
    assert.deepEqual(s.checkMany(keys,2).map(x => x.status),['waiting','waiting']);
    assert.deepEqual(s.checkMany(keys,2).map(x => x.status),['waiting','absent']);
    now = 5n;
    assert.deepEqual(s.checkMany(keys,2).map(x => x.status),['expired','expired']);
    assert.deepEqual(s.checkMany(keys,2).map(x => x.status),['absent','absent']);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions').get().n,0);
    assert.throws(() => s.checkMany(keys,0),/limit/);
    assert.throws(() => s.checkMany(keys,1025),/limit/);
  } finally { db.close(); }
});

test('capacity defers new timers without evicting admitted timers', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const s = new Stopwatch(db, () => now, 1);
    arm(db,'k','a','10'); arm(db,'k','b','10');
    assert.equal(s.check('k','a'),'waiting'); now=9n; assert.equal(s.check('k','b'),'waiting');
    now=10n; assert.equal(s.check('k','a'),'expired');
    assert.equal(s.check('k','b'),'waiting'); now=19n; assert.equal(s.check('k','b'),'waiting');
    now=20n; assert.equal(s.check('k','b'),'expired');
  } finally { db.close(); }
});
