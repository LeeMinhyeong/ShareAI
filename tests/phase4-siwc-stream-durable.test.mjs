import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
Object.assign(process.env,{DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'0'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),NODE_ENV:'test'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {UpstreamError}=await import('../src/upstream/inference.ts');
const db=getDb();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','a'),('b','b'),('c','c'); INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','h','u','u@example.invalid','free'); INSERT INTO siwc_access_policy VALUES('a',1,'all'),('b',1,'all'),('c',1,'all')");
const store=new SiwcStore(db,new CredentialVault());
for(const id of ['a','b','c']) store.create(id,{issuer:'https://auth.openai.com',subject:'synthetic',clientId:`client-${id}`,accessToken:`token-${id}`,idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
const original=globalThis.fetch;
const app=express();app.use(express.json());app.post('/',(req,res,next)=>{req.user={id:'u'};next()},forwardChat);
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const call=(id,stream=false)=>original(`http://127.0.0.1:${server.address().port}/`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],stream,router_options:{siwc_account_id:id}})});
test('untrusted SIWC failure with a stalled cancel: 502 without waiting, 60s restriction, no re-dispatch, late cancel changes nothing',async()=>{
 // ADR 0017: stream disposal is best effort. The outcome must not wait on an untrusted cancel. ADR 0008
 // (2026-11-13): an untrusted envelope is not a provider 429; it is a 2xx response the router cannot use, so the
 // OPEN becomes the 60s restriction, regardless of when (or whether) that cancel settles.
 db.exec("INSERT INTO siwc_accounts VALUES('d','d'); INSERT INTO siwc_access_policy VALUES('d',1,'all');");
 store.create('d',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'client-d',accessToken:'token-d',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
 const unhandled=[];const onUnhandled=e=>unhandled.push(e);process.on('unhandledRejection',onUnhandled);
 const failed={type:'response.failed',sequence_number:0,response:{id:'r',status:'failed',error:{code:'subscription_sharing_usage_limit_exceeded',message:'limit'}},extra:true};
 let calls=0,cancelStarted=false,rejectCancel;
 globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({
  start(c){c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(failed)}\n\n`));},
  cancel(){cancelStarted=true;return new Promise((_,reject)=>{rejectCancel=reject;});},
 }),{headers:{'content-type':'text/event-stream'}});};
 try {
  const started=Date.now();const response=await call('d');
  assert.equal(response.status,502);assert.ok(Date.now()-started<3000,'outcome did not wait on the stalled cancel');
  assert.equal(cancelStarted,true,'cancellation was attempted');
  const open=()=>db.prepare("SELECT attempt_id FROM siwc_account_attempts WHERE account_id='d'").get();
  const restricted=()=>db.prepare("SELECT generation,duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='d'").get();
  assert.equal(open(),undefined,'OPEN converted');const armed=restricted();assert.equal(Number(armed?.duration_ms),60000,'60s restriction, not a 429 hint');
  assert.equal((await call('d')).status,503,'the restriction blocks the account while cancel is pending');assert.equal(calls,1,'no re-dispatch');
  rejectCancel(new Error('synthetic late cancel failure'));await new Promise(r=>setTimeout(r,50));
  assert.equal(open(),undefined);assert.deepEqual(restricted(),armed,'late cancel changes nothing');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM siwc_usage_logs WHERE account_id='d' AND success=1").get().n,0,'no success recorded');
  assert.deepEqual(unhandled,[],'no unhandled rejection from the late cancel');
 } finally {process.off('unhandledRejection',onUnhandled);globalThis.fetch=original;}
});
test('malformed output delta carrying quota code is not a trusted 429',async()=>{
 const http = await import('node:http'); let calls=0;
 const provider=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.output_text.delta","error":{"code":"subscription_sharing_usage_limit_exceeded"}}\n\n');});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 try {
  globalThis.fetch=(_url,init)=>original(`http://127.0.0.1:${provider.address().port}/`,init);
  const response=await call('c');assert.equal(response.status,502);assert.equal(calls,1);
  assert.equal(Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='c'").get()?.duration_ms),60000,'the fixed 60s restriction of an unusable response, not a 429 settlement');
  assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='c'").get(),undefined);
 } finally { globalThis.fetch=original;await new Promise(r=>provider.close(r)); }
});
test('only parser-confirmed SIWC SSE 429 is settled as a 429; a thrown 429 is a transport failure',async()=>{
 let provider;
 try {
  const http=await import('node:http'); provider=http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.failed","sequence_number":0,"response":{"id":"resp_1","status":"failed","error":{"code":"subscription_sharing_usage_limit_exceeded","message":"usage limit"}}}\n\n');});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  globalThis.fetch=(_url,init)=>original(`http://127.0.0.1:${provider.address().port}/`,init);
  const response=await call('a',true);const body=await response.text();
  assert.match(body,/subscription_sharing_usage_limit_exceeded/);assert.doesNotMatch(body,/\[DONE\]/);
  assert.equal(Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='a'").get()?.duration_ms),5000,'a trusted 429 without a hint is settled as a 429 (5s minimum), not as the 60s rest');
  assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get(),undefined);
  globalThis.fetch=async()=>{throw new UpstreamError(429,'fake client error')};
  // A rejected fetch is a transport failure (local 502) whatever it carries: never a 429 to the client, and the
  // fixed 60s restriction instead of a 429 settlement (ADR 0008, 2026-11-13).
  assert.equal((await call('b')).status,502);
  assert.equal(Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='b'").get()?.duration_ms),60000);
  assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='b'").get(),undefined);
 } finally {globalThis.fetch=original;if(provider) await new Promise(r=>provider.close(r));await new Promise(r=>server.close(r));closeDatabase();}
});
