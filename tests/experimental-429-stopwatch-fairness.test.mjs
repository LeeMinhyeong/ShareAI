import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initialize, arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';

test('capacity does not starve five finite restrictions despite rotated polling and indefinite rows', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const watch = new Stopwatch(db, () => now, 2);
    const finite = ['e','b','d','a','c'].map(id => ({kind:'k',id}));
    const keys = [...finite, {kind:'k',id:'indefinite'}];
    for (const key of finite) arm(db,key.kind,key.id,'10');
    arm(db,'k','indefinite',null);
    for (let tick = 0; tick < 100; tick++) {
      const rotated = keys.map((_,i) => keys[(i + tick) % keys.length]);
      watch.checkMany(rotated,1);
      if (now < 10n) assert.equal(db.prepare("SELECT count(*) n FROM experimental_429_restrictions WHERE duration IS NOT NULL").get().n,5);
      now++;
    }
    assert.deepEqual(db.prepare('SELECT account_id FROM experimental_429_restrictions').all(),[{account_id:'indefinite'}]);
  } finally { db.close(); }
});

test('direct checks never evict an admitted observation', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const watch = new Stopwatch(db, () => now, 1);
    arm(db,'k','a','10'); arm(db,'k','b','10');
    assert.equal(watch.check('k','a'),'waiting'); now = 9n;
    assert.equal(watch.check('k','b'),'waiting'); now = 10n;
    assert.equal(watch.check('k','a'),'expired');
    assert.equal(watch.check('k','b'),'waiting'); now=19n;
    assert.equal(watch.check('k','b'),'waiting'); now=20n;
    assert.equal(watch.check('k','b'),'expired');
  } finally { db.close(); }
});
