import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
Object.assign(process.env, {DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'0'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), NODE_ENV:'test'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {getDb, validateSiwcProvisioning, closeDatabase} = await import('../src/db/client.ts');

test('SIWC OPEN schema provisions only for empty database and requires intact marker', () => {
  const empty = new Database(':memory:');
  assert.equal(validateSiwcProvisioning(empty), false);
  empty.exec('CREATE TABLE unrelated(id TEXT)');
  assert.throws(() => validateSiwcProvisioning(empty), /Unsafe SIWC/);
  empty.close();
  const db = getDb();
  assert.equal(validateSiwcProvisioning(db), true);
  db.exec('DELETE FROM siwc_attempts_schema_marker');
  assert.throws(() => validateSiwcProvisioning(db), /Unsafe SIWC/);
  db.exec('INSERT INTO siwc_attempts_schema_marker VALUES(1,1)');
  db.exec('CREATE TABLE hostile(x TEXT REFERENCES siwc_account_attempts(account_id) ON DELETE CASCADE)');
  assert.throws(() => validateSiwcProvisioning(db), /Unsafe SIWC/);
  db.exec('DROP TABLE hostile; DROP TABLE siwc_account_attempts');
  assert.throws(() => validateSiwcProvisioning(db), /Unsafe SIWC/);
  closeDatabase();
});
