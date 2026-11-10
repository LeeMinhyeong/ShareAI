import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {spawnSync} from 'node:child_process';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'ordinary-open-safety-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {settleAccountAttempt}=await import('../src/upstream/account-quota.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(),repo=new AccountRepository();
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'fixture',email:'fixture@example.invalid',tier:'pro',dailyLimit:100});
let handling; const app=express();app.use(express.json());app.post('/v1/chat/completions',authenticateUser,(req,res)=>{handling=forwardChat(req,res)});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
const nativeFetch=globalThis.fetch;
function request(model='gpt-5'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model,messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}}));});}
const create=(name,priority=0)=>repo.create({name,provider:'openai',credentialType:'api_key',credentials:`sk-${name}`,priority});
const open=id=>db.prepare('SELECT account_id,attempt_id FROM ordinary_account_attempts WHERE account_id=?').get(id);
after(async()=>{globalThis.fetch=nativeFetch;server.closeAllConnections();await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true})});

test('OPEN survives 200 headers and closes only after complete terminal', {timeout:10000},async()=>{
 const a=create('terminal'); let body,entered;const barrier=new Promise(r=>entered=r);
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){body=c;entered()}}),{headers:{'content-type':'text/event-stream'}});
 try {const pending=request();await barrier;assert.ok(open(a.id));body.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));body.close();assert.equal(await pending,200);await handling;assert.equal(open(a.id),undefined);}
 finally {globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('truncated stream remains OPEN', {timeout:10000},async()=>{
 const a=create('truncated');globalThis.fetch=async()=>new Response('data: {"choices":[]}\n\n',{headers:{'content-type':'text/event-stream'}});
 try {assert.equal(await request(),502);await handling;assert.ok(open(a.id));}finally{globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('DONE alone leaves OPEN and a new request selects B', {timeout:10000},async()=>{
 const a=create('done-alone'),b=create('done-b',10),calls=[];
 globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response(calls.length===1?'data: [DONE]\n\n':'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 try {assert.equal(await request(),502);await handling;assert.ok(open(a.id));assert.equal(await request(),200);await handling;assert.deepEqual(calls,['Bearer sk-done-alone','Bearer sk-done-b']);assert.ok(open(a.id));assert.equal(open(b.id),undefined);}
 finally {globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'})}
});
test('contradictory Codex completion is rejected', async()=>{
 const {infer}=await import('../src/upstream/inference.ts');
 const f=x=>`data: ${JSON.stringify(x)}\n\n`;
 const created=f({type:'response.created',response:{id:'r',status:'in_progress'}});
 globalThis.fetch=async()=>new Response(created+f({type:'response.completed',response:{id:'r',status:'failed'}}),{headers:{'content-type':'text/event-stream'}});
 try {const events=await infer('openai',{kind:'oauth',token:'synthetic',accountId:'fixture'},{model:'gpt-5',messages:[{role:'user',content:'hi'}]});await assert.rejects(async()=>{for await(const _ of events) {}});}
 finally {globalThis.fetch=nativeFetch}
});
test('redirect never dispatches to a different origin', {timeout:10000},async()=>{
 const a=repo.create({name:'redirect',provider:'anthropic',credentialType:'api_key',credentials:'sk-ant-api-fixture'});let initial=0,leaked=0,seenKey;
 const destination=http.createServer((req,res)=>{leaked++;req.resume();res.end('bad')});await new Promise(r=>destination.listen(0,'127.0.0.1',r));
 const provider=http.createServer((req,res)=>{initial++;seenKey=req.headers['x-api-key'];req.resume();res.writeHead(307,{location:`http://127.0.0.1:${destination.address().port}/steal`});res.end()});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 globalThis.fetch=(_url,opts)=>nativeFetch(`http://127.0.0.1:${provider.address().port}/`,opts);
 try {assert.equal(await request('claude-sonnet-4'),502);await handling;assert.equal(initial,1);assert.equal(seenKey,'sk-ant-api-fixture');assert.equal(leaked,0);}
 finally {globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'});provider.closeAllConnections();destination.closeAllConnections();await new Promise(r=>provider.close(r));await new Promise(r=>destination.close(r))}
});
test('post-start network failure leaves OPEN and never retries', {timeout:10000},async()=>{
 const a=create('network-unknown');let calls=0;globalThis.fetch=async()=>{calls++;throw Error('connection lost')};
 try {assert.equal(await request(),502);await handling;assert.equal(calls,1);assert.ok(open(a.id));}finally{globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('known non-429 rejection settles despite body cancellation failure', {timeout:10000},async()=>{
 const a=create('known-rejection');globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){throw Error('cancel failed')}}),{status:400});
 try {assert.equal(await request(),400);await handling;assert.equal(open(a.id),undefined);}finally{globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('429 commits cooldown and closes only owned OPEN', {timeout:10000},async()=>{
 const a=create('limited');globalThis.fetch=async()=>new Response('limited',{status:429,headers:{'retry-after':'60'}});
 try {assert.equal(await request(),429);await handling;assert.equal(open(a.id),undefined);assert.ok(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(a.id),'v2 restriction armed');}finally{globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('429 finalization failure leaves OPEN and does not publish 429', {timeout:10000},async()=>{
 const a=create('failed-cooldown');// Fail settlement itself (the OPEN delete in the same transaction as the restriction); a trigger on
 // the v2 tables would instead be refused earlier by the v2 schema safety check.
 db.exec("CREATE TRIGGER test_deny_cooldown BEFORE DELETE ON ordinary_account_attempts BEGIN SELECT RAISE(ABORT,'denied'); END");
 // Settlement arms the restriction before deleting OPEN, so this also proves the arm is rolled back.
 const generation=db.prepare('SELECT generation FROM account_429_v2_counter WHERE id=1').safeIntegers().get().generation;
 globalThis.fetch=async()=>new Response('',{status:429});
 try {assert.equal(await request(),503);await handling;assert.ok(open(a.id));assert.equal(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE account_id=?").get(a.id),undefined);
  assert.equal(db.prepare('SELECT generation FROM account_429_v2_counter WHERE id=1').safeIntegers().get().generation,generation,'arm rolled back');}
 finally {db.exec('DROP TRIGGER test_deny_cooldown');globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('429 restriction arm failure inside settlement leaves OPEN and publishes nothing', {timeout:10000},async()=>{
 // Fault-inject arm429V2 itself (not the OPEN delete): an exhausted generation counter makes it
 // throw inside the settlement transaction, before the OPEN delete. Nothing may commit or be swallowed.
 const a=create('failed-arm');
 const counter=()=>db.prepare('SELECT generation FROM account_429_v2_counter WHERE id=1').safeIntegers().get().generation;
 const saved=counter();
 db.prepare('UPDATE account_429_v2_counter SET generation=? WHERE id=1').run(9223372036854775807n);
 globalThis.fetch=async()=>new Response('',{status:429});
 try {
  assert.equal(await request(),503);await handling;
  assert.ok(open(a.id),'OPEN retained');
  assert.equal(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE account_id=?").get(a.id),undefined,'no restriction');
  assert.equal(counter(),9223372036854775807n,'arm did not commit a generation');
  assert.equal(db.prepare("SELECT 1 FROM account_429_cooldowns WHERE account_id=?").get(a.id),undefined,'no legacy write');
 } finally {db.prepare('UPDATE account_429_v2_counter SET generation=? WHERE id=1').run(saved);globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'})}
});
test('OPEN committed by another process after selection falls back before dispatch', {timeout:15000},async()=>{
 const a=create('race-a'),b=create('race-b',10),select=accountPool.selectCandidate;let onceOnly=false;const calls=[];
 accountPool.selectCandidate=async function(...args){const selected=await select.apply(this,args);if(!onceOnly){onceOnly=true;assert.equal(selected.id,a.id);const script="const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run(process.argv[2],'other-process');d.close()";const child=spawnSync(process.execPath,['-e',script,db.name,a.id],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr)}return selected};
 globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})};
 try {assert.equal(await request(),200);await handling;assert.deepEqual(calls,['Bearer sk-race-b']);assert.equal(open(a.id).attempt_id,'other-process');assert.equal(open(b.id),undefined);}
 finally {accountPool.selectCandidate=select;globalThis.fetch=nativeFetch;repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'})}
});
test('owner mismatch and failed finalization leave OPEN intact',async()=>{
 const a=create('cas');db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run(a.id,'owner');
 try {await assert.rejects(settleAccountAttempt({accountId:a.id,attemptId:'wrong'}));await assert.rejects(settleAccountAttempt({accountId:a.id,attemptId:'owner'},()=>{throw Error('failure')}));assert.equal(open(a.id).attempt_id,'owner');}
 finally {repo.update(a.id,{status:'disabled'})}
});
