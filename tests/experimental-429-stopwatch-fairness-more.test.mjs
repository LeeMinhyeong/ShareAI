import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initialize, arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';

test('vanished admitted keys are reread and re-arm restarts their full timer', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const watch = new Stopwatch(db, () => now, 2);
    arm(db,'codex','same','10'); arm(db,'claude','same','10');
    watch.check('codex','same'); watch.check('claude','same');
    now=9n; arm(db,'codex','same','1');
    assert.deepEqual(watch.checkMany([],1),[]);
    now=10n; watch.checkMany([],1);
    assert.deepEqual(db.prepare('SELECT kind FROM experimental_429_restrictions').all(),[{kind:'codex'}]);
    now=18n; watch.checkMany([],1);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions').get().n,1);
    now=19n; watch.checkMany([],1);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions').get().n,0);
  } finally { db.close(); }
});

test('DB errors fail closed and do not skip unsafe expiry', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now=0n; const watch=new Stopwatch(db,()=>now,1);
    arm(db,'k','a','10'); arm(db,'k','b','10');
    watch.check('k','a'); now=10n;
    db.exec("CREATE TRIGGER reject_expiry BEFORE DELETE ON experimental_429_restrictions BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => watch.checkMany([{kind:'k',id:'b'}],1),/injected/);
    assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions').get().n,2);
    db.exec('DROP TRIGGER reject_expiry');
    watch.checkMany([{kind:'k',id:'b'}],1);
    assert.deepEqual(db.prepare('SELECT account_id FROM experimental_429_restrictions').all(),[{account_id:'b'}]);
    now=19n; assert.equal(watch.check('k','b'),'waiting');
    now=20n; assert.equal(watch.check('k','b'),'expired');
  } finally { db.close(); }
});

test('shuffled finite and indefinite keys make progress with constant polling', () => {
  for (let seed=1; seed<=12; seed++) {
    const db=new Database(':memory:');
    try {
      initialize(db); let now=0n; let random=seed; const watch=new Stopwatch(db,()=>now,2);
      const keys=Array.from({length:8},(_,i)=>({kind:i%2?'b':'a',id:String(i)}));
      for (const [i,key] of keys.entries()) arm(db,key.kind,key.id,i<5?'7':null);
      for (let tick=0; tick<150; tick++) {
        const shuffled=[...keys];
        for (let i=shuffled.length-1;i>0;i--) {
          random=(random*1664525+1013904223)>>>0; const j=random%(i+1);
          [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
        }
        watch.checkMany(shuffled,1); now++;
      }
      assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions WHERE duration IS NOT NULL').get().n,0);
      assert.equal(db.prepare('SELECT count(*) n FROM experimental_429_restrictions WHERE duration IS NULL').get().n,3);
    } finally { db.close(); }
  }
});
