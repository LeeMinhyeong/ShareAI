import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Incremental429,fixtureSchema,finitePageSql} from '../src/db/experimental-429-incremental.ts';
function fixture(fn) {
  const dir=mkdtempSync(join(process.env.TMPDIR,'inc429-extra-'));
  const db=new Database(join(dir,'synthetic.db'));
  try {db.exec(fixtureSchema); fn(db);} finally {db.close(); rmSync(dir,{recursive:true,force:true});}
}
test('rearms preserve longer and indefinite restrictions and reset observation',()=>fixture(db=>{
  let now=0n; const s=new Incremental429(db,()=>now);
  s.arm('siwc','same',20n); s.check('siwc','same');
  now=10n; s.arm('siwc','same',1n); assert.equal(s.check('siwc','same'),'waiting');
  now=29n; assert.equal(s.check('siwc','same'),'waiting');
  now=30n; assert.equal(s.check('siwc','same'),'expired');
  s.arm('siwc','same',null); s.arm('siwc','same',1n); now=100n;
  assert.equal(s.check('siwc','same'),'waiting');
  assert.equal(db.prepare('SELECT duration_ns FROM inc429_rows').get().duration_ns,null);
}));
test('restart and kind-separated keys wait separately',()=>fixture(db=>{
  let now=0n; const a=new Incremental429(db,()=>now);
  a.arm('siwc','x',10n); a.arm('upstream','x',10n);
  assert.equal(a.check('siwc','x'),'waiting');
  now=10n; const restarted=new Incremental429(db,()=>now);
  assert.equal(restarted.check('siwc','x'),'waiting');
  assert.equal(a.check('siwc','x'),'expired');
  assert.equal(a.check('upstream','x'),'waiting');
  now=20n; assert.equal(a.check('upstream','x'),'expired');
}));
test('invalid keys, nested transactions, counter overflow and schema changes fail closed',()=>fixture(db=>{
  const s=new Incremental429(db,()=>0n);
  for (const id of ['', '\ud800','x\0y','é'.repeat(257)]) assert.throws(()=>s.arm('siwc',id,1n));
  assert.throws(()=>s.arm('bad','x',1n)); assert.throws(()=>s.arm('siwc','x',-1n));
  assert.throws(()=>db.transaction(()=>s.arm('siwc','x',1n))());
  db.prepare('UPDATE inc429_meta SET counter=?').run(9223372036854775807n);
  assert.throws(()=>s.arm('siwc','x',1n));
  assert.equal(db.prepare('SELECT count(*) AS n FROM inc429_rows').get().n,0);
  db.exec('CREATE TRIGGER injected AFTER INSERT ON inc429_rows BEGIN SELECT 1; END');
  assert.throws(()=>s.page(1),/schema/i);
}));
test('target corruption is rejected but a different corrupt row is not globally scanned',()=>fixture(db=>{
  const s=new Incremental429(db,()=>0n);
  s.arm('siwc','a',5n); s.arm('siwc','z',5n);
  db.prepare('UPDATE inc429_rows SET generation=99 WHERE account_id=?').run('z');
  assert.equal(s.check('siwc','a'),'waiting');
  assert.throws(()=>s.check('siwc','z'),/Invalid restriction/);
  assert.throws(()=>s.page(10),/Invalid restriction/);
}));
test('keyset pages cover a stable finite set and the actual query uses the partial index',()=>fixture(db=>{
  const s=new Incremental429(db,()=>0n);
  for (let i=0;i<25;i++) s.arm('upstream',String(i).padStart(2,'0'),2n);
  s.arm('siwc','forever',null);
  let cursor,got=[]; do {const p=s.page(10,cursor); got.push(...p.rows); cursor=p.cursor;} while(cursor);
  assert.equal(got.length,25); assert.equal(new Set(got.map(x=>x.id)).size,25);
  const plan=db.prepare('EXPLAIN QUERY PLAN '+finitePageSql).all('','',10);
  assert.match(JSON.stringify(plan),/inc429_finite/);
}));
test('injected statement failure after counter write rolls back the arm',()=>fixture(db=>{
  const s=new Incremental429(db,()=>0n); s.arm('siwc','x',5n);
  const before=db.prepare('SELECT * FROM inc429_meta').get();
  const prior=db.prepare('SELECT * FROM inc429_rows').all();
  const original=db.prepare.bind(db); let witnessed=false;
  db.prepare=function(sql) {
    if (sql.startsWith('INSERT INTO inc429_rows VALUES')) {
      assert.equal(db.inTransaction,true);
      assert.equal(original('SELECT counter FROM inc429_meta').get().counter,before.counter+1);
      witnessed=true;
      return original("INSERT INTO inc429_rows VALUES('invalid-'||?,?,?,?)");
    }
    return original(sql);
  };
  try {assert.throws(()=>s.arm('siwc','x',10n),/CHECK constraint failed/);} finally {db.prepare=original;}
  assert.equal(witnessed,true);
  assert.deepEqual(db.prepare('SELECT * FROM inc429_meta').get(),before);
  assert.deepEqual(db.prepare('SELECT * FROM inc429_rows').all(),prior);
}));
test('clock exceptions discard the previous observation',()=>fixture(db=>{
  let now=0n, fail=false; const s=new Incremental429(db,()=>{if(fail) throw Error('clock fault'); return now;});
  s.arm('siwc','clock',10n); assert.equal(s.check('siwc','clock'),'waiting');
  fail=true; assert.throws(()=>s.check('siwc','clock'),/clock fault/);
  fail=false; now=10n; assert.equal(s.check('siwc','clock'),'waiting');
  now=20n; assert.equal(s.check('siwc','clock'),'expired');
}));
test('one real monotonic wait cannot expire early',async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR,'inc429-real-')); const db=new Database(join(dir,'synthetic.db'));
  try {db.exec(fixtureSchema); const s=new Incremental429(db); s.arm('siwc','real',20000000n);
    assert.equal(s.check('siwc','real'),'waiting');
    await new Promise(r=>setTimeout(r,35)); assert.equal(s.check('siwc','real'),'expired');
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
