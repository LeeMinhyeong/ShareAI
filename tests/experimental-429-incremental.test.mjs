import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Incremental429, fixtureSchema} from '../src/db/experimental-429-incremental.ts';

test('finite rows are paged and expiry observes a committed generation', () => {
  const dir=mkdtempSync(join(process.env.TMPDIR,'inc429-'));
  const db=new Database(join(dir,'fixture.db'));
  try {
    db.exec(fixtureSchema);
    let now=0n;
    const store=new Incremental429(db,()=>now);
    store.arm('upstream','a',10n);
    store.arm('upstream','b',null);
    assert.deepEqual(store.page(10).rows,[{kind:'upstream',id:'a'}]);
    assert.equal(store.check('upstream','a'),'waiting');
    now=9n; assert.equal(store.check('upstream','a'),'waiting');
    now=10n; assert.equal(store.check('upstream','a'),'expired');
    assert.equal(store.check('upstream','b'),'waiting');
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
