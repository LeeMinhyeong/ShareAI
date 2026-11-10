import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {chatStream} from './phase4-protocol-fixtures.mjs';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'quota-result-'));
const file=path.join(dir,'router.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
getDb().prepare('INSERT INTO users(id,api_key_hash,name,email,tier) VALUES(?,?,?,?,?)').run('fixture','fixture-hash','fixture','fixture@example.invalid','free');
new AccountRepository().create({name:'fixture',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',dailyQuota:0});
let handling;
const app=express();app.use(express.json());app.post('/chat',(req,res)=>{req.user={id:'fixture'};handling=forwardChat(req,res).catch(()=>{if(!res.headersSent)res.status(500).end();});});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
after(async()=>{await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('quota writer timeout responds without a second blocking failure write', {timeout:12000},async()=>{
 const child=fork(new URL('./phase4-result-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected provider');};
 try {
  await once(child,'message');
  const start=performance.now();
  const response=new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}]}));});
  await new Promise(r=>setTimeout(r,5100));
  assert.ok(performance.now()-start<6500,'quota timeout blocked event loop');
  assert.equal(await response,503);assert.equal(calls,0);
 } finally {globalThis.fetch=original;if(child.connected)child.send('release');if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');if(handling)await handling;}
});
for (const scenario of ['success','failure']) test(`provider ${scenario} does not block event loop while another process owns writer`, {timeout:15000},async()=>{
 let child;
 const original=globalThis.fetch; let locked;
 const barrier=new Promise(resolve=>locked=resolve);
 globalThis.fetch=async()=>{child=fork(new URL('./phase4-result-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']}); await once(child,'message'); locked(); return scenario === 'failure' ? new Response('',{status:500}) : new Response(chatStream,{status:200,headers:{'content-type':'text/event-stream'}});};
 try {
  let published=false;const response=new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/chat',method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>{published=true;resolve(res.statusCode)});});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}]}));});
  await Promise.race([barrier, response.then(status=>{throw new Error(`provider was not reached: ${status}`);}), new Promise((_,reject)=>setTimeout(()=>reject(new Error('provider barrier timeout')),3000))]);
  const start=performance.now();await new Promise(r=>setTimeout(r,100));
  assert.ok(performance.now()-start<1000,'event loop blocked on account failure write');
  assert.equal(published,false,'terminal must wait for durable settlement');
  child.send('release'); await once(child,'exit');
  assert.equal(await response,scenario === 'failure' ? 500 : 200);
 } finally {globalThis.fetch=original;if(child?.connected)child.send('release');if(child && child.exitCode===null&&child.signalCode===null)await once(child,'exit');if(handling)await handling;}
});
