import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {chatStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'cooldown-http-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const repo=new AccountRepository(); getDb();
const userRepo=new UserRepository();
const user=userRepo.create({apiKeyHash:hashApiKey('fixture-key'),name:'test',email:'test@example.invalid',tier:'pro',dailyLimit:100});
let handling;
const app=express();app.use(express.json());app.post('/v1/chat/completions',authenticateUser,(req,res)=>{handling=forwardChat(req,res);});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
const originalFetch=globalThis.fetch;
function request(strategy='priority',key='fixture-key') {return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy}}));});}
const create=(name,priority=0)=>repo.create({name,provider:'openai',credentialType:'api_key',credentials:`sk-${name}`,priority});
after(async()=>{globalThis.fetch=originalFetch;await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});

test('authenticated request with all accounts cooling returns 429 with Retry-After without selecting or dispatching (ADR 0019 item 8)', {timeout:5000},async()=>{
 const a=create('cool-a'),b=create('cool-b'); const clock=Date.now;const now=clock();Date.now=()=>now;
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response('failure',{status:500});};
 try {
  accountPool.recordFailure(a.id,{status:500,message:'fixture'});accountPool.recordFailure(b.id,{status:500,message:'fixture'});
  const initialUsage=userRepo.getTodayUsageCount(user.id);
  const unauthorized=await request('priority','invalid-fixture-key');
  assert.equal(unauthorized.status,401);
  assert.equal(userRepo.getTodayUsageCount(user.id),initialUsage);
  assert.equal(handling,undefined);
  let admitted=0;
  for(const strategy of ['priority','least_used','round_robin']) {
   const response=await request(strategy);await handling;
   assert.equal(response.status,429);
   assert.match(String(response.headers?.['retry-after']),/^[56]$/,'the remaining 5-6s backoff after one failure is announced');
   assert.deepEqual(JSON.parse(response.body),{error:{type:'upstream_error',message:'All upstream accounts for this request are busy or resting. Retry shortly.'}});
   assert.equal(userRepo.getTodayUsageCount(user.id),initialUsage+(++admitted));
  }
  assert.equal(calls,0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM account_daily_reservations WHERE account_id IN (?,?)').get(a.id,b.id).n,0);
  assert.equal(await accountPool.selectCandidate('test','gpt-5','openai','priority'),null);
 } finally {Date.now=clock;globalThis.fetch=originalFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});}
});

test('mixed cooldown eligibility applies to every strategy and expires at the deadline', {timeout:5000},async()=>{
 const a=create('mixed-cooling',0),b=create('mixed-ready',10);const clock=Date.now;let now=clock();Date.now=()=>now;const tokens=[];
 globalThis.fetch=async (_url,opts)=>{tokens.push(opts.headers.authorization);return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};
 try {
  accountPool.recordFailure(a.id,{status:500,message:'fixture'});
  const deadline=accountPool.cooldownOf(a.id);
  for(const strategy of ['priority','least_used','round_robin']) {const response=await request(strategy);await handling;assert.equal(response.status,200);}
  assert.deepEqual(tokens,['Bearer sk-mixed-ready','Bearer sk-mixed-ready','Bearer sk-mixed-ready']);
  now=deadline-1;assert.equal(accountPool.getCandidates('openai','priority').some(x=>x.id===a.id),false);
  now=deadline;assert.equal(accountPool.getCandidates('openai','priority')[0].id,a.id);
 } finally {Date.now=clock;globalThis.fetch=originalFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});}
});

test('provider 429 never fails over within the same authenticated request', {timeout:5000},async()=>{
 const a=create('rate-first',0),b=create('rate-second',10);const tokens=[];
 globalThis.fetch=async (_url,opts)=>{tokens.push(opts.headers.authorization);return new Response('limited',{status:429});};
 try {const response=await request();await handling;assert.equal(response.status,429);assert.deepEqual(tokens,['Bearer sk-rate-first']);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM account_daily_reservations WHERE account_id=?').get(b.id).n,0);
 } finally {globalThis.fetch=originalFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});}
});

test('disconnect aborts an in-flight provider call without same-request failover', {timeout:5000},async()=>{
 const a=create('cancel-first',0),b=create('cancel-second',10);let entered;const barrier=new Promise(resolve=>entered=resolve);const tokens=[];
 globalThis.fetch=async (_url,opts)=>{tokens.push(opts.headers.authorization);entered();return new Promise((_resolve,reject)=>{if(opts.signal.aborted)reject(opts.signal.reason);else opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});});};
 let req;
 try {req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}});req.on('error',()=>{});req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}]}));
  let timer;try {await Promise.race([barrier,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('provider dispatch barrier timed out')),3000);})]);} finally {clearTimeout(timer);}
  req.destroy();await handling;assert.deepEqual(tokens,['Bearer sk-cancel-first']);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM account_daily_reservations WHERE account_id=?').get(b.id).n,0);
 } finally {req?.destroy();globalThis.fetch=originalFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});}
});
