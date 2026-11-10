import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'quota-integration-'));
const file=path.join(dir,'router.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const {arm429V2}=await import('../src/db/account-429-v2-store.ts');
const db=getDb(), repo=new AccountRepository();
let inference=0, refresh=0, mode='failure';
const server=http.createServer((req,res)=>{
  if(req.url==='/token') { refresh++; res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({access_token:'newtoken',refresh_token:'newrefresh',expires_in:3600})); return; }
  inference++;
  if(mode==='retry' && inference===1){res.writeHead(401);res.end();return;}
  if(mode==='failure'){res.writeHead(500);res.end();return;}
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(responseStream);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
assert.notEqual(port,20128);
const worker=fileURLToPath(new URL('./phase4-account-quota-worker.mjs',import.meta.url));
// A provider 500 now arms the shared 5xx restriction (ADR 0016). Quota-counting cases that
// deliberately fail repeatedly clear it first so each run reaches admission and dispatch.
const dispatchedSinceClear=new Set();
async function runUnrestricted(id){
 // Only this account's own shared 5xx restriction is cleared, and only after asserting the
 // previous dispatched 500 actually armed it.
 if(dispatchedSinceClear.has(id)) assert.ok(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id),'the previous 500 armed the shared 5xx restriction');
 db.prepare("DELETE FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").run(id);
 const before=inference; const out=await run();
 if(inference>before) dispatchedSinceClear.add(id); else dispatchedSinceClear.delete(id);
 return out;
}
function run(){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),worker,file,String(port)],{env:process.env,stdio:['ignore','pipe','pipe']});
 let out='',err=''; child.stdout.on('data',x=>out+=x); child.stderr.on('data',x=>err+=x);
 const timer=setTimeout(()=>{child.kill();reject(new Error('worker timeout'));},30000);
 child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code!==0) reject(new Error(`worker ${code}: ${err} ${out}`));else resolve(out);});
});}
after(async()=>{await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('ordinary selection enforces quota across competing processes',async()=>{
 const a=repo.create({name:'race',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',dailyQuota:1});
 const output=await Promise.all(Array.from({length:5},run));
 assert.equal(inference,1);assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 assert.equal(output.filter(x=>x.includes('RESULT:500')).length,1);
 repo.update(a.id,{status:'disabled'});
});
test('401 refresh makes two separately charged provider requests',async()=>{
 inference=0;refresh=0;mode='retry';
 const a=repo.create({name:'oauth',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'oldtoken',refreshToken:'oldrefresh',accountId:'fixture'}),dailyQuota:2});
 const result=await run();assert.match(result,/RESULT:200/);assert.equal(inference,2);assert.equal(refresh,1);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,2);
 assert.equal(JSON.parse(repo.findById(a.id).credentials).accessToken,'newtoken');
 repo.update(a.id,{status:'disabled'});
});
test('401 cannot retry when only one reservation is available',async()=>{
 inference=0;refresh=0;mode='retry';
 const a=repo.create({name:'oauth-one',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'oldtoken',refreshToken:'anotherrefresh',accountId:'fixture'}),dailyQuota:1});
 const result=await run();assert.match(result,/RESULT:503/);assert.equal(inference,1);assert.equal(refresh,1);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 repo.update(a.id,{status:'disabled'});
});
test('unlimited attempts count, and a prior UTC day rolls over',async()=>{
 inference=0;mode='failure';
 const a=repo.create({name:'unlimited',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',dailyQuota:0});
 await runUnrestricted(a.id); await runUnrestricted(a.id);assert.equal(inference,2);
 repo.update(a.id,{dailyQuota:2});await runUnrestricted(a.id);assert.equal(inference,2);
 db.prepare("UPDATE account_daily_reservations SET day='2000-01-01' WHERE account_id=?").run(a.id);
 await runUnrestricted(a.id);assert.equal(inference,3);
 const row=db.prepare('SELECT day,used FROM account_daily_reservations WHERE account_id=?').get(a.id);
 assert.equal(row.day,new Date().toISOString().slice(0,10));assert.equal(row.used,1);
 repo.update(a.id,{status:'disabled'});
});
test('cooldown after committed reservation is not a retryable admission race',async()=>{
 const {invokeAccountAttempt,AccountCooldownBeforeDispatch,AccountQuotaUnavailable}=await import('../src/upstream/account-quota.ts');
 const a=repo.create({name:'cooldown-after-reservation',provider:'openai',credentialType:'api_key',credentials:'sk-fixture'});
 let calls=0;
 try {
  await assert.rejects(invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());},()=>{
   db.transaction(()=>arm429V2(db,'upstream',a.id,30000)).immediate(); // ADR 0008: the shared cooldown is a v2 restriction
  }),error=>error instanceof AccountQuotaUnavailable && !(error instanceof AccountCooldownBeforeDispatch));
  assert.equal(calls,0);assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 } finally {repo.update(a.id,{status:'disabled'});}
});
test('state change after commit prevents dispatch without refund',async()=>{
 const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
 const a=repo.create({name:'fence',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',dailyQuota:1});
 let calls=0;
 const pending=invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());});
 repo.update(a.id,{credentials:'sk-replaced'});
 await assert.rejects(pending);assert.equal(calls,0);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 assert.equal(repo.findById(a.id).credentials,'sk-replaced');
 repo.update(a.id,{status:'disabled'});
});
test('dispatch fence rejects an intervening refresh intent',async()=>{
 const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
 const a=repo.create({name:'intent-fence',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:'unique-intent',accountId:'fixture'}),dailyQuota:1});
 let calls=0; const pending=invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());});
 repo.claimRefresh(a.id,a.credentials);
 await assert.rejects(pending); assert.equal(calls,0); repo.update(a.id,{status:'disabled'});
});
test('dispatch fence sees a refresh claim committed by another process',async()=>{
 const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
 const a=repo.create({name:'process-intent-fence',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:'process-unique',accountId:'fixture'}),dailyQuota:1});
 let calls=0; const pending=invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());});
 const child=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('./phase4-intent-fence-worker.mjs',import.meta.url)),file,a.id],{env:process.env,encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr); await assert.rejects(pending); assert.equal(calls,0);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 repo.update(a.id,{status:'disabled'});
});
test('dispatch fence rejects access tokens that expire after reservation',async()=>{
 const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
 const now=Date.now(); const a=repo.create({name:'expiry-fence',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',expiresAt:now+1000,accountId:'fixture'}),dailyQuota:1});
 const original=Date.now; let calls=0;
 try {
  const pending=invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());});
  Date.now=()=>now+1001;
  await assert.rejects(pending); assert.equal(calls,0);
 } finally { Date.now=original; repo.update(a.id,{status:'disabled'}); }
});
test('cancellation after claim retains the charge and suppresses dispatch',async()=>{
 const {invokeAccountAttempt}=await import('../src/upstream/account-quota.ts');
 const a=repo.create({name:'aborted',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',dailyQuota:1});
 const controller=new AbortController();let calls=0;
 const pending=invokeAccountAttempt(a,controller.signal,()=>{calls++;return Promise.resolve(new Response());});
 controller.abort();await assert.rejects(pending);assert.equal(calls,0);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 repo.update(a.id,{status:'disabled'});
});
test('legacy cutover preserves credentials and blocks later limits until the next UTC day across restart',async()=>{
 inference=0;mode='failure';
 const a=repo.create({name:'legacy',provider:'openai',credentialType:'api_key',credentials:'sk-legacy',dailyQuota:0});
 db.exec("ALTER TABLE upstream_accounts ADD COLUMN extra_fixture TEXT; UPDATE upstream_accounts SET extra_fixture='preserved' WHERE name='legacy'; DROP TABLE account_daily_reservations; DROP TABLE account_quota_migration_marker;");
 await runUnrestricted(a.id);assert.equal(inference,1);
 let row=db.prepare('SELECT * FROM account_daily_reservations WHERE account_id=?').get(a.id);
 assert.equal(row.legacy_ambiguous,1);assert.equal(row.used,1);
 repo.update(a.id,{dailyQuota:20});await runUnrestricted(a.id);assert.equal(inference,1);
 assert.equal(repo.findById(a.id).credentials,'sk-legacy');
 assert.equal(db.prepare('SELECT extra_fixture FROM upstream_accounts WHERE id=?').get(a.id).extra_fixture,'preserved');
 row=db.prepare('SELECT * FROM account_daily_reservations WHERE account_id=?').get(a.id);assert.equal(row.legacy_ambiguous,1);assert.equal(row.used,1);
 db.prepare("UPDATE account_daily_reservations SET day='2000-01-01' WHERE account_id=?").run(a.id);
 await runUnrestricted(a.id);assert.equal(inference,2);
});
