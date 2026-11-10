import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {chatStream,responseStream} from './phase4-protocol-fixtures.mjs';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'completion-clock-')), file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false',TZ:'America/New_York'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {hashApiKey,CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'test','u@example.invalid','pro',100);
const account=new AccountRepository().create({name:'test',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',priority:0});
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('s','test'); INSERT INTO siwc_access_policy VALUES('s',1,'all')");
db.prepare("INSERT INTO siwc_routing_settings(account_id,priority,weight) VALUES('s',1,1)").run();
new SiwcStore(db,new CredentialVault()).create('s',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'fixture',accessToken:'synthetic-access',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:'2029-12-31T23:59:00.000Z'});
const realNow=Date.now,realFetch=globalThis.fetch;let clock=Date.parse('2029-12-31T23:59:59.899Z'),handling,child,ready;
Date.now=()=>clock;
globalThis.fetch=async (_url,opts)=>new Response(opts.headers.authorization==='Bearer synthetic-access'?responseStream:chatStream,{headers:{'content-type':'text/event-stream'}});
const app=express();app.use(express.json());app.post('/chat',authenticateUser,(req,res)=>{
 const original=res.json;res.json=function(body){
  child=fork(new URL('./phase4-completion-clock-worker.mjs',import.meta.url),[file,ready],{stdio:['ignore','ignore','inherit','ipc']});
  const deadline=performance.now()+4000;while(!existsSync(ready)&&performance.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  if(!existsSync(ready)) throw new Error('writer readiness timeout');
  clock=Date.parse('2030-01-01T00:00:00.100Z');
  setTimeout(()=>child.send('release'),100);
  return original.call(this,body);
 };handling=forwardChat(req,res);
});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
after(async()=>{Date.now=realNow;globalThis.fetch=realFetch;await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
for(const [kind,backward] of [['upstream',false],['siwc',false],['upstream',true]]) test(`${kind} records completion before logging writer crosses UTC midnight${backward?' with a backward wall jump':''}`,{timeout:10000},async()=>{
 clock=Date.parse('2029-12-31T23:59:59.899Z');ready=path.join(dir,`${kind}-${backward}.ready`);child=undefined;
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 // Move the wall clock separately from the actual monotonic duration.
 const completed=backward?'2029-12-31T23:59:58.999Z':'2029-12-31T23:59:59.999Z';
 const oldFetch=globalThis.fetch;globalThis.fetch=async (...args)=>{const result=await oldFetch(...args);clock=Date.parse(completed);return result;};
 try {
  const status=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:kind==='siwc'?{siwc_account_id:'s'}:{strategy:'priority'}}));});
  assert.equal(status,200);await handling;if(child.exitCode===null)await once(child,'exit');
  const rows=db.prepare(`SELECT timestamp,latency_ms,success FROM ${kind==='siwc'?'siwc_usage_logs':'usage_logs'}`).all();
  assert.equal(rows.length,1);assert.equal(rows[0].timestamp,completed);assert.equal(rows[0].success,1);assert.ok(Number.isSafeInteger(rows[0].latency_ms)&&rows[0].latency_ms>=0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ordinary_account_attempts').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM siwc_account_attempts').get().n,0);
  assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(account.id).used,backward?2:1);
 } finally {globalThis.fetch=oldFetch;if(child?.connected)child.send('release');if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'exit');}
});
test('usage completion timestamps reject non-integer or out-of-range values',async()=>{
 const {UsageLogRepository}=await import('../src/db/repositories/usage-logs.ts');
 const repo=new UsageLogRepository(), base={userId:'u',upstreamAccountId:account.id,model:'gpt-5',provider:'openai',inputTokens:0,outputTokens:0,success:true,latencyMs:0};
 for(const value of [null,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER,'0']) assert.throws(()=>repo.create({...base,completedAtMs:value}),RangeError);
 for(const value of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'0']) assert.throws(()=>repo.create({...base,latencyMs:value}),RangeError);
});
test('ordinary 429 samples failure before a contended logging writer crosses midnight', {timeout:10000},async()=>{
 clock=Date.parse('2029-12-31T23:59:59.999Z');ready=path.join(dir,'failure.ready');child=undefined;
 db.exec('DELETE FROM usage_logs');
 const oldFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('synthetic sensitive body',{status:429});};
 try {
  const status=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}]}));});
  assert.equal(status,429);await handling;if(child.exitCode===null)await once(child,'exit');assert.equal(calls,1);
  const rows=db.prepare('SELECT timestamp,latency_ms,success,error FROM usage_logs').all();assert.equal(rows.length,1);assert.equal(rows[0].timestamp,'2029-12-31T23:59:59.999Z');assert.equal(rows[0].success,0);assert.equal(rows[0].error,null);assert.ok(Number.isSafeInteger(rows[0].latency_ms)&&rows[0].latency_ms>=0);
 } finally {globalThis.fetch=oldFetch;if(child?.connected)child.send('release');if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'exit');}
});
