import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createFixture} from './experimental-atomic-429-fixture.mjs';
import {armAndSettle} from '../src/db/experimental-atomic-429-settle.ts';

const scratch=realpathSync(join(homedir(),'AppData','Local','hermes','cache','scratch'));
assert.equal(realpathSync(tmpdir()),scratch);
const tables=['experimental_atomic_429_marker','experimental_atomic_429_restrictions','ordinary_account_attempts','siwc_account_attempts'];
function snapshot(db) {
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name').all();
  const indexList=db.prepare("SELECT * FROM pragma_index_list(?, 'main') ORDER BY name");
  const indexInfo=db.prepare("SELECT * FROM pragma_index_xinfo(?, 'main') ORDER BY seqno");
  return {
    journal:db.pragma('main.journal_mode',{simple:true}),
    foreignKeys:db.pragma('foreign_keys',{simple:true}),
    schema,
    indexes:tables.map(table=>({table,indexes:indexList.all(table).map(index=>({ ...index,columns:indexInfo.all(index.name)}))})),
    rows:tables.map(table=>({table,rows:db.prepare(`SELECT * FROM main.${table} ORDER BY 1,2`).safeIntegers().all()})),
  };
}

test('real SQLite statement failure after both writes rolls back both kinds in WAL',()=>{
  for(const [kind,table] of [['upstream','ordinary_account_attempts'],['siwc','siwc_account_attempts']]) {
    const dir=mkdtempSync(join(scratch,'atomic-429-rollback-'));
    const file=join(dir,'fixture.db'); let db, reopened;
    try {
      closeSync(openSync(file,'wx',0o600)); db=new Database(file,{fileMustExist:true});
      assert.equal(db.pragma('journal_mode = WAL',{simple:true}),'wal');
      db.pragma('foreign_keys = ON'); createFixture(db);
      db.prepare('UPDATE experimental_atomic_429_marker SET generation=4').run();
      db.prepare('INSERT INTO experimental_atomic_429_restrictions VALUES (?,?,?,?)').run(kind,'account',4n,40n);
      db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run('account','owner');
      const before=snapshot(db); let reached=false;
      assert.equal(before.journal,'wal'); assert.equal(before.foreignKeys,1);
      assert.deepEqual(before.schema.filter(entry=>entry.type==='table').map(entry=>entry.name),[...tables].sort());
      assert.equal(before.schema.filter(entry=>entry.type==='index').length,3);
      assert.equal(before.indexes.reduce((count,entry)=>count+entry.indexes.length,0),3);
      assert.ok(before.indexes.flatMap(entry=>entry.indexes).every(index=>index.columns.length>0));
      const original=db.prepare;
      db.prepare=function(sql) {
        const stmt=original.call(this,sql);
        if(sql===`DELETE FROM main.${table} WHERE account_id=? AND attempt_id=?`) {
          return {run:(...args)=>{
            assert.equal(db.inTransaction,true);
            assert.deepEqual(args,['account','owner']);
            assert.deepEqual(original.call(db,'SELECT generation FROM main.experimental_atomic_429_marker').safeIntegers().get(),{generation:5n});
            assert.deepEqual(original.call(db,'SELECT generation,duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind,'account'),{generation:5n,duration_ns:90n});
            assert.deepEqual(original.call(db,`SELECT attempt_id FROM main.${table} WHERE account_id=?`).get('account'),{attempt_id:'owner'});
            reached=true;
            // Deliberate SQLite integer overflow, not an actual disk or I/O failure.
            return original.call(db,'SELECT abs(-9223372036854775808)').get();
          }};
        }
        return stmt;
      };
      try {
        assert.throws(()=>armAndSettle(db,{kind,accountId:'account',attemptId:'owner',durationNs:90n}),e=>e.code==='SQLITE_ERROR' && /integer overflow/i.test(e.message));
      } finally {db.prepare=original;}
      assert.equal(reached,true); assert.equal(db.inTransaction,false);
      assert.deepEqual(snapshot(db),before);
      db.close(); db=undefined;
      // foreign_keys is connection-local; explicitly restore it on the new connection.
      reopened=new Database(file,{fileMustExist:true}); reopened.pragma('foreign_keys = ON');
      assert.deepEqual(snapshot(reopened),before);
    } finally {reopened?.close(); db?.close(); rmSync(dir,{recursive:true,force:true});}
  }
});

test('invalid inputs and corrupted state fail closed without reflecting secrets',()=>{
  const db=new Database(':memory:');
  try {
    createFixture(db);
    db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('secret-account','secret-attempt');
    const good={kind:'upstream',accountId:'secret-account',attemptId:'secret-attempt',durationNs:1n};
    for(const durationNs of [-1n,9223372036854775808n,'-1','malformed',1,1.5,undefined,{},NaN]) {
      const before=snapshot(db);
      assert.throws(()=>armAndSettle(db,{...good,durationNs}),e=>/input/.test(e.message) && !e.message.includes('secret'));
      assert.deepEqual(snapshot(db),before);
    }
    const before=snapshot(db);
    assert.throws(()=>armAndSettle(db,{...good,kind:"upstream'; DROP TABLE ordinary_account_attempts;--"}),/input/);
    assert.deepEqual(snapshot(db),before);
    // null is the supported indefinite duration, not an invalid input.
    assert.equal(armAndSettle(db,{...good,durationNs:null}),1n);
    assert.equal(db.prepare('SELECT duration_ns FROM experimental_atomic_429_restrictions').get().duration_ns,null);
    db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('secret-account','secret-attempt');
    const corruptions=[
      ['DELETE FROM experimental_atomic_429_marker','counter'],
      ['UPDATE experimental_atomic_429_marker SET generation=-1','counter'],
      ['UPDATE experimental_atomic_429_marker SET version=2','counter'],
      ['UPDATE experimental_atomic_429_marker SET generation=0','state'],
      ['UPDATE experimental_atomic_429_restrictions SET kind=\'bad\'','state'],
      ['UPDATE experimental_atomic_429_restrictions SET duration_ns=-1','state'],
      ["UPDATE experimental_atomic_429_restrictions SET duration_ns='malformed'",'state'],
      ['UPDATE experimental_atomic_429_restrictions SET generation=0','state'],
    ];
    for(const [sql,error] of corruptions) {
      db.exec('SAVEPOINT fixture_corruption');
      try {
        db.pragma('ignore_check_constraints = ON'); db.exec(sql); db.pragma('ignore_check_constraints = OFF');
        const initial=snapshot(db);
        // Exit the fixture savepoint first: settlement rejects outer transactions.
        db.exec('RELEASE fixture_corruption');
        assert.throws(()=>armAndSettle(db,good),e=>e.message.includes(error) && !e.message.includes('secret'));
        assert.deepEqual(snapshot(db),initial);
      } finally {
        if(db.inTransaction) db.exec('ROLLBACK TO fixture_corruption; RELEASE fixture_corruption');
        db.pragma('ignore_check_constraints = ON');
        db.exec("DELETE FROM experimental_atomic_429_marker; INSERT INTO experimental_atomic_429_marker VALUES (1,1,1); UPDATE experimental_atomic_429_restrictions SET kind='upstream',generation=1,duration_ns=NULL");
        db.pragma('ignore_check_constraints = OFF');
      }
    }
  } finally {db.close();}
});
