import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createFixture} from './experimental-atomic-429-fixture.mjs';
import * as experiment from '../src/db/experimental-atomic-429-settle.ts';

// Synthetic schema only: this is not an application integration test.
test('standalone settlement rejects outer transactions and commits', () => {
  assert.equal(typeof experiment.armAndSettleInWriter, 'undefined');
  for (const [kind, table] of [['upstream','ordinary_account_attempts'], ['siwc','siwc_account_attempts']]) {
    const db = new Database(':memory:');
    try {
      createFixture(db);
      const input = {kind, accountId:'account', attemptId:'owner', durationNs:10n};
      db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run('account','owner');
      assert.throws(() => db.transaction(() => experiment.armAndSettle(db,input)).immediate(), /active transaction/i);
      assert.ok(db.prepare(`SELECT 1 FROM ${table}`).get());
      assert.equal(db.prepare('SELECT 1 FROM experimental_atomic_429_restrictions').get(), undefined);
      assert.equal(db.prepare('SELECT generation FROM experimental_atomic_429_marker').get().generation, 0);
      assert.equal(experiment.armAndSettle(db,input), 1n);
      assert.equal(db.prepare(`SELECT 1 FROM ${table}`).get(), undefined);
      assert.deepEqual(db.prepare('SELECT kind,account_id,generation,duration_ns FROM experimental_atomic_429_restrictions').get(), {kind,account_id:'account',generation:1,duration_ns:10});
    } finally { db.close(); }
  }
});
