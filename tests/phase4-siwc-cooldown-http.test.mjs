import {test, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {responseStream,chatStream} from './phase4-protocol-fixtures.mjs';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-cooldown-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('private-account','a'); INSERT INTO siwc_access_policy VALUES ('private-account',1,'selected')");
for (const [id,key] of [['allowed','allowed-key'],['denied','denied-key']]) db.prepare('INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit) VALUES (?,?,?,?,?,?)').run(id,hashApiKey(key),id,`${id}@example.invalid`,'pro',100);
db.prepare("INSERT INTO siwc_access_users VALUES ('private-account','allowed')").run();
const store=new SiwcStore(db,new CredentialVault());
const credential={issuer:'https://auth.openai.com',subject:'synthetic',clientId:'fixture-client',accessToken:'synthetic-access',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()};
store.create('private-account',credential);
// Isolate the synthetic account between scenarios, including unknown outcomes.
beforeEach(()=>{
 db.prepare("DELETE FROM siwc_account_attempts WHERE account_id='private-account'").run();
 db.prepare("DELETE FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='private-account'").run(); // ADR 0008: the cooldown is the v2 restriction
 store.replace('private-account',credential);
});
let handling; const app=express();app.use(express.json());app.post('/chat',authenticateUser,(req,res)=>{handling=forwardChat(req,res);});
const server=app.listen(0,'127.0.0.1'); await once(server,'listening');assert.notEqual(server.address().port,20128);
const originalFetch=globalThis.fetch;
async function send(options={}, key='allowed-key') {const response=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:options}));});await handling;return response;}
after(async()=>{globalThis.fetch=originalFetch;await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('SIWC provider failure cools automatic and explicit selection without leaking ACL', {timeout:5000},async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:429});};
 assert.equal((await send()).status,429);
 // ADR 0019 item 8: automatic selection announces the short wait; an explicit pin below keeps its 503.
 for(const strategy of ['priority','least_used','round_robin']) {const response=await send({strategy});assert.equal(response.status,429);assert.doesNotMatch(response.body,/private-account/);assert.match(String(response.headers['retry-after']),/^[56]$/,'the local 5-6s backoff after one failure');}
 assert.equal((await send({siwc_account_id:'private-account'})).status,503);
 assert.equal((await send({siwc_account_id:'private-account'},'denied-key')).status,404);
 assert.equal(calls,1);
});
test('cooling SIWC yields to a ready ordinary account', {timeout:5000},async()=>{
 globalThis.fetch=async()=>new Response('',{status:429});
 assert.equal((await send()).status,429);
 const repo=new AccountRepository(); const account=repo.create({name:'ready',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',priority:10}); let calls=0;
 globalThis.fetch=async (_url,opts)=>{calls++;assert.equal(opts.headers.authorization,'Bearer sk-fixture');return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};
 try {for(const strategy of ['priority','least_used','round_robin']) assert.equal((await send({strategy})).status,200);assert.equal(calls,3);} finally {repo.update(account.id,{status:'disabled'});}
});
test('late 429 restricts the account despite credential replacement', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'old-access'});
 let entered,release; const barrier=new Promise(r=>entered=r); const hold=new Promise(r=>release=r);
 globalThis.fetch=async()=>{entered();await hold;return new Response('',{status:429});};
 const pending=send();
 try {await Promise.race([barrier,new Promise((_,reject)=>setTimeout(()=>reject(new Error('dispatch timed out')),2000))]);store.replace('private-account',{...credential,accessToken:'new-access'});}
 finally {release();}
 assert.equal((await pending).status,429);
 let calls=0;globalThis.fetch=async (_url,opts)=>{calls++;assert.equal(opts.headers.authorization,'Bearer new-access');return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 assert.equal((await send()).status,429);assert.equal(calls,0);
 assert.ok(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='private-account'").get(), 'v2 restriction armed');
});
// Wall-clock offset expires the local backoff; the shared v2 restriction expires on a monotonic
// clock through the expiry service (not running here), so its removal is simulated explicitly.
const expireRestriction=()=>assert.equal(db.prepare("DELETE FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='private-account'").run().changes,1,'the 429 armed a siwc v2 restriction');
test('success resets consecutive failures after cooldown expires', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'reset-access'});
 const now=Date.now; let offset=0; Date.now=()=>now()+offset;
 try {
  globalThis.fetch=async()=>new Response('',{status:429}); assert.equal((await send()).status,429);
  offset+=6000; expireRestriction(); globalThis.fetch=async()=>new Response(responseStream,{headers:{'content-type':'text/event-stream'}}); assert.equal((await send()).status,200);
  globalThis.fetch=async()=>new Response('',{status:429}); assert.equal((await send()).status,429);
  offset+=6000; expireRestriction(); globalThis.fetch=async()=>new Response(responseStream,{headers:{'content-type':'text/event-stream'}}); assert.equal((await send()).status,200);
 } finally {Date.now=now;}
});
test('invalid fetch response reports local 502 and retains OPEN', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'bad-status'});
 globalThis.fetch=async()=>({ok:false,headers:new Headers(),body:null});
 assert.equal((await send()).status,502);
 // This is the router's 502, not a claimed upstream status: the mock is not a Response.
 assert.equal(db.prepare("SELECT status FROM siwc_usage_logs WHERE account_id=? ORDER BY rowid DESC LIMIT 1").get('private-account').status,502);
 assert.ok(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='private-account'").get());
 assert.equal((await send()).status,429);
});
test('an OPEN blocks the same SIWC but allows another account', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'race-access'});
 db.prepare("INSERT INTO siwc_accounts VALUES ('other-account','b')").run();
 db.prepare("INSERT INTO siwc_access_policy VALUES ('other-account',1,'all')").run();
 store.create('other-account',{...credential,clientId:'other-client',accessToken:'other-access'});
 let entered,release;const barrier=new Promise(r=>entered=r);const hold=new Promise(r=>release=r);
 const calls=[];globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);if(opts.headers.authorization==='Bearer race-access'){entered();await hold;}return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 const pending=send({siwc_account_id:'private-account'});
 try {
  await Promise.race([barrier,pending.then(()=>{throw new Error('request ended before dispatch');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('dispatch timed out')),2000))]);
  assert.equal((await send({siwc_account_id:'private-account'})).status,503);
  assert.ok(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='private-account'").get());
  assert.equal((await send({siwc_account_id:'other-account'})).status,200);
  assert.deepEqual(calls,['Bearer race-access','Bearer other-access']);
 } finally {release();db.prepare("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='other-account'").run();}
 assert.equal((await pending).status,200);assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='private-account'").get(),undefined);
 globalThis.fetch=async()=>{calls.push('later');return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 assert.equal((await send()).status,200);assert.deepEqual(calls,['Bearer race-access','Bearer other-access','later']);
});
test('credential replacement cannot bypass OPEN and works after settlement', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'old-success'});
 let entered,release;const barrier=new Promise(r=>entered=r);const hold=new Promise(r=>release=r);
 let calls=0;globalThis.fetch=async()=>{if(++calls===1){entered();await hold;return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});}return new Response('',{status:429});};
 const pending=send();
 try {await Promise.race([barrier,new Promise((_,reject)=>setTimeout(()=>reject(new Error('dispatch timed out')),2000))]);store.replace('private-account',{...credential,accessToken:'new-failure'});assert.equal((await send()).status,429);assert.equal(calls,1);} finally {release();}
 assert.equal((await pending).status,200);
 globalThis.fetch=async (_url,opts)=>{calls++;assert.equal(opts.headers.authorization,'Bearer new-failure');return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 assert.equal((await send()).status,200);assert.equal(calls,2);
});
test('settings default, saved strategy and request override govern routing', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'strategy-access'});
 const repo=new AccountRepository();const account=repo.create({name:'strategy-api',provider:'openai',credentialType:'api_key',credentials:'sk-strategy',priority:10});
 const {accountPool}=await import('../src/account-pool/manager.ts'); const key='strategy.openai';
 const original=db.prepare('SELECT value FROM settings WHERE key=?').get(key); const seen=[];
 globalThis.fetch=async (_url,opts)=>{seen.push(opts.headers.authorization);return opts.headers.authorization==='Bearer sk-strategy' ? new Response(chatStream,{headers:{'content-type':'text/event-stream'}}) : new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 try {
  db.prepare('DELETE FROM settings WHERE key=?').run(key);accountPool.roundRobinCounters.clear();
  assert.equal((await send()).status,200);assert.equal((await send()).status,200);assert.deepEqual(seen,['Bearer strategy-access','Bearer strategy-access']);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key,'round_robin');seen.length=0;
  assert.equal((await send()).status,200);assert.equal((await send()).status,200);assert.deepEqual(new Set(seen),new Set(['Bearer strategy-access','Bearer sk-strategy']));
  seen.length=0;assert.equal((await send({strategy:'priority'})).status,200);assert.equal((await send({strategy:'priority'})).status,200);assert.deepEqual(seen,['Bearer strategy-access','Bearer strategy-access']);
 } finally {repo.update(account.id,{status:'disabled'});db.prepare('DELETE FROM settings WHERE key=?').run(key);if(original)db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(key,original.value);}
});
test('non-retryable 4xx settles and invalid fetch objects retain OPEN', {timeout:5000},async()=>{
 for(const status of [400,401,403,404]) {
  store.replace('private-account',{...credential,accessToken:`valid-${status}`});let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('',{status});};
  assert.equal((await send()).status,status);assert.equal((await send()).status,status);assert.equal(calls,2);
 }
 for(const status of [NaN,99,200,302,600,500.5]) {
  db.prepare("DELETE FROM siwc_account_attempts WHERE account_id='private-account'").run();
  store.replace('private-account',{...credential,accessToken:`invalid-${status}`});let calls=0;
  globalThis.fetch=async()=>{calls++;return {ok:false,status,headers:new Headers(),body:null};};
  assert.equal((await send()).status,502);assert.ok(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='private-account'").get());assert.equal((await send()).status,429);assert.equal(calls,1);
 }
});
test('local pre-dispatch validation failure does not cool SIWC', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'validation-access'});let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 assert.equal((await send({siwc_account_id:'private-account',invalid:true})).status,400);
 assert.equal((await send()).status,200);assert.equal(calls,1);
});
test('cancelled dispatched SIWC converts its OPEN into a 60s restriction (ADR 0008, 2026-11-09)', {timeout:5000},async()=>{
 store.replace('private-account',{...credential,accessToken:'cancel-access'});
 let entered;const barrier=new Promise(r=>entered=r);let calls=0;
 globalThis.fetch=async (_url,opts)=>{calls++;entered();return new Promise((_resolve,reject)=>{if(opts.signal.aborted)reject(new Error('aborted'));else opts.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});};
 const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{authorization:'Bearer allowed-key','content-type':'application/json'}});req.on('error',()=>{});req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}]}));
 try {await Promise.race([barrier,new Promise((_,reject)=>setTimeout(()=>reject(new Error('dispatch timed out')),2000))]);req.destroy();await handling;} finally {req.destroy();}
 globalThis.fetch=async()=>{calls++;return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 // A router-abandoned dispatched attempt is no longer an indefinite OPEN: it becomes a finite shared restriction.
 assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='private-account'").get(),undefined,'OPEN converted');
 assert.equal(Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='private-account'").get()?.duration_ms),60000,'60s restriction');
 assert.equal((await send()).status,429);assert.equal(calls,1);
});
