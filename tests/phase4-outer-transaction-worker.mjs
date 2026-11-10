import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';

const mode=process.argv[2];
assert.equal(mode,'file'); // in-memory SQLite is unsupported (ADR 0018)
const dir=mkdtempSync(path.join(process.env.TMPDIR,'outer-txn-'));
const target=mode==='file' ? path.join(dir,'fixture.sqlite') : ':memory:';
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${target}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'});
let closeDatabase;
try {
  const client=await import('../src/db/client.ts'); closeDatabase=client.closeDatabase;
  const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
  const {withAsyncWriter}=await import('../src/db/async-writer.ts');
  const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
  // The production client never creates a database; provision this owned fixture file.
  if(mode==='file') await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
  const db=client.getDb(), repo=new AccountRepository();
  assert.equal(db.name,target);
  const account=repo.create({name:'fixture',provider:'openai',credentialType:'api_key',credentials:'synthetic-key',dailyQuota:2});
  let calls=0, writerCalls=0; const unhandled=[];
  const onUnhandled=error=>unhandled.push(error);
  process.on('unhandledRejection',onUnhandled);
  db.exec('BEGIN');
  try {
    await assert.rejects(invokeAccountAttempt(account,new AbortController().signal,()=>{calls++;return Promise.reject(new Error('provider called'));}),/active.*transaction/i);
    assert.throws(()=>withAsyncWriter(()=>{writerCalls++;}),/active.*transaction/i);
    assert.equal(writerCalls,0); assert.equal(calls,0);
  } finally {db.exec('ROLLBACK');}
  await new Promise(resolve=>setImmediate(resolve));
  process.off('unhandledRejection',onUnhandled);
  assert.deepEqual(unhandled,[]);
  assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(account.id),undefined);
  process.send({mode,passed:true});
} finally {
  closeDatabase?.();
  rmSync(dir,{recursive:true,force:true});
}
