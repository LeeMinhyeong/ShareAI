import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize, arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';

test('requires a full local monotonic observation before expiry', () => {
  const db = new Database(':memory:');
  try {
    initialize(db);
    arm(db, 'codex', 'a', '10');
    let now = 9007199254740993000n;
    const watch = new Stopwatch(db, () => now);
    assert.equal(watch.check('codex', 'a'), 'waiting');
    now += 9n;
    assert.equal(watch.check('codex', 'a'), 'waiting');
    now += 1n;
    assert.equal(watch.check('codex', 'a'), 'expired');
    assert.equal(watch.check('codex', 'a'), 'absent');
  } finally { db.close(); }
});
