import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'cancel-selection-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('synthetic-user'),'u','u@example.invalid','pro',100);
const account=new AccountRepository().create({name:'fixture',provider:'openai',credentialType:'api_key',credentials:'synthetic'});
let handling, closedResolve;const serverClosed=new Promise(r=>closedResolve=r);const app=express();app.use(express.json());app.post('/chat',authenticateUser,(req,res)=>{res.on('close',closedResolve);handling=forwardChat(req,res);});const server=app.listen(0,'127.0.0.1');await once(server,'listening');
after(async()=>{await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('valid authenticated request cancelled after selection does not dispatch or record failure', {timeout:10000},async()=>{
 let selectedResolve,release;const selected=new Promise(r=>selectedResolve=r), barrier=new Promise(r=>release=r);
 const originalSelect=accountPool.selectCandidate, originalFetch=globalThis.fetch;
 let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected provider call');};
 accountPool.selectCandidate=async function(...args){const candidate=await originalSelect.apply(this,args);assert.equal(candidate?.id,account.id);selectedResolve();await barrier;return candidate;};
 const before=db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(account.id);
 const userBefore=db.prepare('SELECT COALESCE(SUM(used),0) n FROM user_daily_quota WHERE user_id=?').get('u').n;
 const reservationBefore=db.prepare('SELECT day,used,legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(account.id);
 const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{authorization:'Bearer synthetic-user','content-type':'application/json'}});req.on('error',()=>{});
 try {
  req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy:'priority'}}));
  await selected;req.destroy();await serverClosed;release();await handling;
  assert.equal(calls,0);assert.deepEqual(db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(account.id),before);assert.equal(accountPool.cooldownOf(account.id),0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ordinary_account_attempts').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_logs').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM siwc_usage_logs').get().n,0);
  assert.equal(db.prepare('SELECT COALESCE(SUM(used),0) n FROM user_daily_quota WHERE user_id=?').get('u').n,userBefore+1);
  assert.deepEqual(db.prepare('SELECT day,used,legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(account.id),reservationBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_429_cooldowns').get().n,0);
 } finally {release();req.destroy();accountPool.selectCandidate=originalSelect;globalThis.fetch=originalFetch;}
});
