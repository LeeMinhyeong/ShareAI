import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const scratch = join(homedir(),'AppData','Local','hermes','cache','scratch');
mkdirSync(scratch,{recursive:true});
const dir=mkdtempSync(join(scratch,'async-writer-')), file=join(dir,'db.sqlite');
process.env.DATABASE_URL=`sqlite:${file}`; process.env.ENCRYPTION_KEY='0'.repeat(64); process.env.ADMIN_API_KEY='x'.repeat(20);
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {withAsyncWriter}=await import('../src/db/async-writer.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(); db.exec('CREATE TABLE writer_probe (n INTEGER NOT NULL)');
const worker = () => fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
test('independent lock retries without blocking and invokes transaction only once', async () => {
  const child=worker(); let calls=0;
  try {
    await once(child,'message');
    const start=Date.now();
    const result=withAsyncWriter(writer=>{ calls++; writer.prepare('INSERT INTO writer_probe VALUES (1)').run(); return 42; });
    await new Promise(r=>setTimeout(r,80));
    assert.ok(Date.now()-start<300,'event loop stalled on lock');
    assert.equal(calls,0);
    assert.equal(await result,42);
    assert.equal(calls,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM writer_probe').get().n,1);
  } finally { if(child.exitCode===null && child.signalCode===null){child.kill(); await once(child,'exit');} }
});
test('cancellation while waiting never executes writer', async () => {
  const child=worker(), controller=new AbortController(); let calls=0;
  try {
    await once(child,'message');
    const result=Promise.resolve(withAsyncWriter(()=>{calls++;}, {signal:controller.signal}));
    controller.abort(); await assert.rejects(result);
    assert.equal(calls,0);
  } finally { if(child.exitCode===null && child.signalCode===null){child.kill(); await once(child,'exit');} }
});
test('a shared transaction opened while waiting prevents the retry callback', async () => {
  const child=worker(); let calls=0;
  try {
    await once(child,'message');
    const result=Promise.resolve(withAsyncWriter(()=>{calls++;}));
    db.exec('BEGIN');
    try {
      await assert.rejects(result,/active.*transaction/i);
      assert.equal(calls,0);
    } finally {db.exec('ROLLBACK');}
  } finally {if(child.exitCode===null && child.signalCode===null){child.kill(); await once(child,'exit');}}
});
test('write errors roll back and are not retried', () => {
  let calls=0;
  assert.throws(()=>withAsyncWriter(writer=>{calls++; writer.prepare('INSERT INTO writer_probe VALUES (2)').run(); throw new Error('synthetic write failure');}),/synthetic write failure/);
  assert.equal(calls,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM writer_probe WHERE n=2').get().n,0);
});
after(()=>{closeDatabase(); rmSync(dir,{recursive:true,force:true});});
