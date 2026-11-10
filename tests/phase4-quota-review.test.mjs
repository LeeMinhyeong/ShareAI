import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'quota-review-')),file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository,refreshFingerprint}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {invokeAccountAttempt,AccountQuotaUnavailable,AccountQuotaExhausted}=await import('../src/upstream/account-quota.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(),repo=new AccountRepository();
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'test',email:'test@example.invalid',tier:'pro',dailyLimit:100});
const app=express();let handling;app.use(express.json());app.post('/v1/chat/completions',authenticateUser,(req,res)=>{handling=forwardChat(req,res);});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
const worker=fileURLToPath(new URL('./phase4-quota-review-lock-worker.mjs',import.meta.url));
async function lock(){const child=fork(worker,[file],{stdio:['ignore','ignore','inherit','ipc']}); await Promise.race([once(child,'message'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('lock timeout')),5000);t.unref();child.once('exit',()=>{clearTimeout(t);reject(new Error('lock exited early'));});})]);return child;}
async function unlock(child,message={}){const done=once(child,'exit');child.send(message);const [code]=await done;assert.equal(code,0);}
function request(){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy:'priority'}}));});}
const RealDate=globalThis.Date, originalFetch=globalThis.fetch, originalSelect=accountPool.selectCandidate;
after(async()=>{globalThis.Date=RealDate;globalThis.fetch=originalFetch;accountPool.selectCandidate=originalSelect;await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('UTC day is sampled after a cross-process writer lock is acquired',{timeout:10000},async()=>{
 const a=repo.create({name:'midnight',provider:'openai',credentialType:'api_key',credentials:'sk-midnight',dailyQuota:1});
 db.prepare('INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous) VALUES (?,?,1,0)').run(a.id,'2030-01-01');
 let now=RealDate.parse('2030-01-01T23:59:59.999Z');
 globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}};
 const child=await lock();let released=false;
 try {let calls=0;const pending=invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());});pending.catch(()=>{});
  now=RealDate.parse('2030-01-02T00:00:00.001Z');await unlock(child);released=true;
  await pending;assert.equal(calls,1);assert.deepEqual(db.prepare('SELECT day,used FROM account_daily_reservations WHERE account_id=?').get(a.id),{day:'2030-01-02',used:1});
 } finally {if(!released){child.kill();}globalThis.Date=RealDate;repo.update(a.id,{status:'disabled'});}
});
test('exhaustion does not mask expired credentials or an outstanding refresh intent',async()=>{
 for(const kind of ['expired','intent']){
  const a=repo.create({name:kind,provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:`refresh-${kind}`,accountId:'fixture',...(kind==='expired'?{expiresAt:Date.now()-1}:{})}),dailyQuota:1});
  db.prepare('INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous) VALUES (?,?,1,0)').run(a.id,new Date().toISOString().slice(0,10));
  if(kind==='intent')repo.claimRefresh(a.id,a.credentials);
  let calls=0;await assert.rejects(invokeAccountAttempt(a,new AbortController().signal,()=>{calls++;return Promise.resolve(new Response());}),e=>e instanceof AccountQuotaUnavailable && !(e instanceof AccountQuotaExhausted),kind);
  assert.equal(calls,0);assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);repo.update(a.id,{status:'disabled'});
 }
});
test('authenticated request does not fall back when refresh intent appears before reservation',{timeout:10000},async()=>{
 const a=repo.create({name:'first',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:'http-refresh',accountId:'fixture'}),priority:0,dailyQuota:1});
 const b=repo.create({name:'second',provider:'openai',credentialType:'api_key',credentials:'sk-second',priority:10,dailyQuota:1});
 db.prepare('INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous) VALUES (?,?,0,0)').run(a.id,new Date().toISOString().slice(0,10));
 let selected;const barrier=new Promise(r=>selected=r);let child;accountPool.selectCandidate=async function(...args){const result=await originalSelect.apply(this,args);if(!child){assert.equal(result.id,a.id);child=await lock();selected();}return result;};
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 let released=false;
 try {const response=request();await barrier;await new Promise(r=>setTimeout(r,100));
  // Commit the competing intent while still holding the independent writer lock.
  await unlock(child,{fingerprint:refreshFingerprint('openai','http-refresh'),accountId:a.id});released=true;
  const result=await response;await handling;assert.equal(result.status,503,result.text);assert.match(result.text,/Upstream account quota or state unavailable/);assert.equal(calls,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_daily_reservations WHERE account_id=?').get(b.id).n,0);
 } finally {if(!released)child.kill();accountPool.selectCandidate=originalSelect;globalThis.fetch=originalFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});}
});
