import assert from 'node:assert/strict';
// In-memory SQLite is unsupported by the production client (ADR 0018); use a provisioned private file.
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const client=await import('../src/db/client.ts');
const {settleAppAttempt}=await import('../src/db/experimental-atomic-429-app.ts');
const {AppStopwatch}=await import('../src/db/experimental-app-stopwatch.ts');
const db=client.getDb();
try {
  db.exec(`CREATE TABLE experimental_atomic_429_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0));
CREATE TABLE experimental_atomic_429_restrictions (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(account_id)>0), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR (typeof(duration_ns)='integer' AND duration_ns>=0)), PRIMARY KEY(kind,account_id));
INSERT INTO experimental_atomic_429_marker VALUES (1,1,0);
INSERT INTO ordinary_account_attempts VALUES ('account','owner');`);
  await settleAppAttempt({kind:'upstream',accountId:'account',attemptId:'owner',durationNs:10n});
  let now=0n;
  const sw=new AppStopwatch('upstream','account',()=>now);
  const row=()=>db.prepare('SELECT * FROM experimental_atomic_429_restrictions').all();
  if (process.argv[2]==='timeout') {
    const before=row();
    for (const timeoutMs of [Infinity,NaN,-1,30001,0.5]) {
      await assert.rejects(sw.check({timeoutMs}),/timeout/i);
      assert.deepEqual(row(),before);
    }
    assert.equal(await sw.check({timeoutMs:0}),'waiting');
    assert.equal(await sw.check({timeoutMs:30000}),'waiting');
  } else {
    assert.equal(await sw.check(),'waiting');
    now=10n;
    db.exec('BEGIN');
    try { await assert.rejects(sw.check(),/autocommit/); assert.equal(row().length,1); }
    finally {db.exec('ROLLBACK');}
    assert.equal(await sw.check(),'expired');
    assert.equal(row().length,0);
    db.exec("INSERT INTO ordinary_account_attempts VALUES ('clock','owner2')");
    await settleAppAttempt({kind:'upstream',accountId:'clock',attemptId:'owner2',durationNs:10n});
    let calls=0;
    const throwing=new AppStopwatch('upstream','clock',()=>{ if (++calls===3) throw new Error('clock fault'); return calls===1?0n:10n; });
    assert.equal(await throwing.check(),'waiting');
    const before=row();
    await assert.rejects(throwing.check(),/clock fault/);
    assert.deepEqual(row(),before);
    assert.equal(db.inTransaction,false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ordinary_account_attempts').get().n,0);
    let tick=0n;
    const a=new AppStopwatch('upstream','clock',()=>tick), b=new AppStopwatch('upstream','clock',()=>tick);
    assert.deepEqual(await Promise.all([a.check(),b.check()]),['waiting','waiting']);
    tick=10n;
    assert.deepEqual((await Promise.all([a.check(),b.check()])).sort(),['absent','expired']);
  }
} finally {client.closeDatabase();}
