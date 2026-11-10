import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initialize, arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';

test('overlap retains the longest full duration and restarts observation', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const watch = new Stopwatch(db, () => now);
    const first = arm(db, 'codex', 'a', '100');
    assert.equal(watch.check('codex', 'a'), 'waiting'); now = 90n;
    const second = arm(db, 'codex', 'a', '5');
    assert.notEqual(first, second);
    assert.equal(db.prepare('SELECT duration FROM experimental_429_restrictions').get().duration, '100');
    assert.equal(watch.check('codex', 'a'), 'waiting'); now = 189n;
    assert.equal(watch.check('codex', 'a'), 'waiting'); now = 190n;
    assert.equal(watch.check('codex', 'a'), 'expired');
  } finally { db.close(); }
});

test('alternating colliding account ids preserves both observations', () => {
  const db = new Database(':memory:');
  try {
    initialize(db); let now = 0n; const watch = new Stopwatch(db, () => now);
    arm(db, 'codex', 'a', '10'); arm(db, 'claude', 'a', '10');
    assert.equal(watch.check('codex', 'a'), 'waiting');
    assert.equal(watch.check('claude', 'a'), 'waiting'); now = 10n;
    assert.equal(watch.check('codex', 'a'), 'expired');
    assert.equal(watch.check('claude', 'a'), 'expired');
  } finally { db.close(); }
});
