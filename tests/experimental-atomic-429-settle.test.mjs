import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createFixture} from './experimental-atomic-429-fixture.mjs';
const {armAndSettle: settle}=await import('../src/db/experimental-atomic-429-settle.ts');
const db=new Database(':memory:');
createFixture(db);
const armAndSettle=input=>settle(db,input);
after(()=>db.close());
const insert=(table,id,attempt)=>db.prepare(`INSERT INTO main.${table} VALUES (?,?)`).run(id,attempt);
const read=(kind,id)=>db.prepare('SELECT generation,duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind,id);
test('owned OPEN is atomically replaced with a restriction',async()=>{
  db.prepare('INSERT INTO main.ordinary_account_attempts VALUES (?,?)').run('account','attempt');
  const generation=await armAndSettle({kind:'upstream',accountId:'account',attemptId:'attempt',durationNs:100n});
  assert.equal(generation,1n);
  assert.equal(db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get('account'),undefined);
  assert.deepEqual(db.prepare('SELECT generation,duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get('upstream','account'),{generation:1n,duration_ns:100n});
});
test('rearms preserve the maximum duration and indefinite dominates independently by namespace',async()=>{
  for(const [i,d] of [10n,200n,20n,null,300n].entries()) {
    insert('ordinary_account_attempts','account',`a${i}`);
    await armAndSettle({kind:'upstream',accountId:'account',attemptId:`a${i}`,durationNs:d});
    const row=read('upstream','account');
    assert.equal(row.duration_ns,[100n,200n,200n,null,null][i]);
    assert.equal(row.generation,BigInt(i+2));
  }
  insert('siwc_account_attempts','account','si');
  await armAndSettle({kind:'siwc',accountId:'account',attemptId:'si',durationNs:7n});
  assert.equal(read('siwc','account').duration_ns,7n);
  assert.equal(read('upstream','account').duration_ns,null);
});
test('lost ownership and invalid kind leave OPEN and restriction unchanged',async()=>{
  insert('ordinary_account_attempts','lost','owner');
  const before=db.prepare('SELECT * FROM main.experimental_atomic_429_marker').get();
  await assert.rejects(async()=>armAndSettle({kind:'upstream',accountId:'lost',attemptId:'stale',durationNs:1n}),/ownership/);
  assert.throws(()=>armAndSettle({kind:'ordinary',accountId:'lost',attemptId:'owner',durationNs:1n}),/input/);
  assert.deepEqual(db.prepare('SELECT * FROM main.experimental_atomic_429_marker').get(),before);
  assert.equal(db.prepare('SELECT attempt_id FROM main.ordinary_account_attempts WHERE account_id=?').get('lost').attempt_id,'owner');
  assert.equal(read('upstream','lost'),undefined);
});
test('injected delete trigger is rejected before any write',async()=>{
  insert('siwc_account_attempts','fault','owner');
  const before=db.prepare('SELECT * FROM main.experimental_atomic_429_marker').get();
  db.exec("CREATE TRIGGER experimental_test_fault BEFORE DELETE ON siwc_account_attempts BEGIN SELECT RAISE(ABORT,'fault injected'); END");
  try { await assert.rejects(async()=>armAndSettle({kind:'siwc',accountId:'fault',attemptId:'owner',durationNs:9n}),/schema/); }
  finally { db.exec('DROP TRIGGER experimental_test_fault'); }
  assert.deepEqual(db.prepare('SELECT * FROM main.experimental_atomic_429_marker').get(),before);
  assert.equal(read('siwc','fault'),undefined);
  assert.ok(db.prepare('SELECT 1 FROM main.siwc_account_attempts WHERE account_id=?').get('fault'));
});
test('missing marker and exhausted exact 64-bit counter fail closed',async()=>{
  insert('siwc_account_attempts','counter','owner');
  db.prepare('UPDATE main.experimental_atomic_429_marker SET generation=?').run(9223372036854775807n);
  await assert.rejects(async()=>armAndSettle({kind:'siwc',accountId:'counter',attemptId:'owner',durationNs:1n}),/counter/);
  db.prepare('DELETE FROM main.experimental_atomic_429_marker').run();
  await assert.rejects(async()=>armAndSettle({kind:'siwc',accountId:'counter',attemptId:'owner',durationNs:1n}),/counter/);
  assert.ok(db.prepare('SELECT 1 FROM main.siwc_account_attempts WHERE account_id=?').get('counter'));
  db.prepare('INSERT INTO main.experimental_atomic_429_marker VALUES (1,1,?)').run(9007199254740992n);
  assert.equal(await armAndSettle({kind:'siwc',accountId:'counter',attemptId:'owner',durationNs:1n}),9007199254740993n);
});
test('SQLite constraints reject invalid rows',()=>{
  assert.throws(()=>db.prepare('INSERT INTO main.experimental_atomic_429_restrictions VALUES (?,?,?,?)').run('bad','id',1n,1n));
  assert.throws(()=>db.prepare('INSERT INTO main.experimental_atomic_429_restrictions VALUES (?,?,?,?)').run('siwc','id',0n,1n));
  assert.throws(()=>db.prepare('INSERT INTO main.experimental_atomic_429_restrictions VALUES (?,?,?,?)').run('siwc','id',1n,-1n));
});
test('an outer transaction is rejected without deleting the OPEN',async()=>{
  insert('ordinary_account_attempts','nested','owner');
  db.exec('BEGIN');
  try { await assert.rejects(async()=>armAndSettle({kind:'upstream',accountId:'nested',attemptId:'owner',durationNs:1n}),/active transaction/); }
  finally {db.exec('ROLLBACK');}
  assert.ok(db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get('nested'));
});
test('temporary shadow tables do not intercept writes',async()=>{
  insert('ordinary_account_attempts','shadow','owner');
  db.exec('CREATE TEMP TABLE ordinary_account_attempts(account_id TEXT,attempt_id TEXT); CREATE TEMP TABLE experimental_atomic_429_marker(id,version,generation); CREATE TEMP TABLE experimental_atomic_429_restrictions(kind,account_id,generation,duration_ns)');
  try { await assert.rejects(async()=>armAndSettle({kind:'upstream',accountId:'shadow',attemptId:'owner',durationNs:5n}),/schema/); }
  finally { db.exec('DROP TABLE temp.ordinary_account_attempts; DROP TABLE temp.experimental_atomic_429_marker; DROP TABLE temp.experimental_atomic_429_restrictions'); }
  assert.equal(read('upstream','shadow'),undefined);
  assert.ok(db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get('shadow'));
});
test('injected deletion trigger is rejected before any settlement writes or authorization',async()=>{
  insert('ordinary_account_attempts','trigger-attack','owner');
  const before=db.prepare('SELECT * FROM main.experimental_atomic_429_marker').get();
  db.exec('CREATE TRIGGER attack AFTER INSERT ON experimental_atomic_429_restrictions BEGIN DELETE FROM experimental_atomic_429_restrictions WHERE kind=NEW.kind AND account_id=NEW.account_id; END');
  let authorized=false;
  try {
    await assert.rejects(async()=>{ await armAndSettle({kind:'upstream',accountId:'trigger-attack',attemptId:'owner',durationNs:1n}); authorized=true; },/schema/);
    assert.equal(authorized,false);
    assert.deepEqual(db.prepare('SELECT * FROM main.experimental_atomic_429_marker').get(),before);
    assert.ok(db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get('trigger-attack'));
    assert.equal(read('upstream','trigger-attack'),undefined);
  } finally { db.exec('DROP TRIGGER attack'); }
});
test('unexpected indexes, views and incorrect primary key shapes fail closed',async()=>{
  for (const mutation of [
    'CREATE INDEX extra ON experimental_atomic_429_restrictions(duration_ns)',
    'CREATE UNIQUE INDEX extra ON experimental_atomic_429_restrictions(account_id,kind)',
    'CREATE INDEX extra ON experimental_atomic_429_restrictions(kind) WHERE duration_ns IS NOT NULL',
    'CREATE VIEW extra AS SELECT * FROM experimental_atomic_429_restrictions',
    `DROP TABLE experimental_atomic_429_restrictions; CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(account_id,kind))`,
  ]) {
    const local=new Database(':memory:');
    try {
      createFixture(local);local.exec(mutation);
      local.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('case','owner');
      let authorized=false;
      await assert.rejects(async()=>{settle(local,{kind:'upstream',accountId:'case',attemptId:'owner',durationNs:1n});authorized=true;},/schema/);
      assert.equal(authorized,false);
      assert.deepEqual(local.prepare('SELECT * FROM experimental_atomic_429_marker').get(),{id:1,version:1,generation:0});
      assert.ok(local.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get('case'));
      assert.equal(local.prepare('SELECT 1 FROM experimental_atomic_429_restrictions').get(),undefined);
    } finally {local.close();}
  }
});
test('truncated or replaced restriction schema refuses settlement',async()=>{
  insert('ordinary_account_attempts','broken','owner');
  db.exec('DROP TABLE main.experimental_atomic_429_restrictions; CREATE TABLE main.experimental_atomic_429_restrictions(kind TEXT)');
  await assert.rejects(async()=>armAndSettle({kind:'upstream',accountId:'broken',attemptId:'owner',durationNs:1n}),/schema/);
  assert.ok(db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get('broken'));
});
