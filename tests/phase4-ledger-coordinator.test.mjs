import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import * as ledger from '../src/db/durable-ledger-foundation.ts';

test('committed OPEN can enter start only once across repeated calls', async () => {
  assert.equal(typeof ledger.dispatchOpenAttemptOnce, 'function');
  const dir = mkdtempSync(path.join(process.env.TMPDIR, 'ledger-once-'));
  const file = path.join(dir, 'fixture.sqlite');
  const db = new Database(file);
  try {
    ledger.migrateLedger(db);
    assert.equal(ledger.openAttempt(db, 'one'), true);
    let starts = 0;
    assert.equal(await ledger.dispatchOpenAttemptOnce(file, 'one', () => {}, () => { starts++; return Promise.resolve('ok'); }), 'ok');
    await assert.rejects(ledger.dispatchOpenAttemptOnce(file, 'one', () => {}, () => { starts++; return Promise.resolve('bad'); }));
    assert.equal(starts, 1);
  } finally { db.close(); rmSync(dir, {recursive:true, force:true}); }
});
