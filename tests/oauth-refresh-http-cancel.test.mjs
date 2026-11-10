import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'oauth-http-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
const {drainTokenRefreshes}=await import('../src/upstream/tokens.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
getDb();const repo=new AccountRepository();new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'test',email:'test@example.invalid',tier:'pro',dailyLimit:20});
const app=express();app.use(express.json());let handling;app.post('/v1/chat/completions',authenticateUser,(req,res)=>{handling=forwardChat(req,res);});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
function request(){const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},r=>r.resume());req.on('error',()=>{});req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}]}));return req;}
const create=(name,expiresAt)=>repo.create({name,provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:name,accountId:'fixture',expiresAt})});
after(async()=>{await drainTokenRefreshes();await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('authenticated HTTP refresh yields while another process owns the writer', {timeout:7000},async()=>{
 const a=create('http-lock',Date.now()-1);const oldFetch=globalThis.fetch,oldSelect=accountPool.selectCandidate;let child,locked;const barrier=new Promise(r=>locked=r);
 accountPool.selectCandidate=async function(...args){const candidate=await oldSelect.apply(this,args);child=fork(new URL('./phase4-result-lock-worker.mjs',import.meta.url),[getDb().name],{stdio:['ignore','ignore','inherit','ipc']});await once(child,'message');locked();return candidate;};
 globalThis.fetch=async url=>String(url).includes('oauth/token') ? new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600})) : new Response('data: {"type":"response.completed","response":{}}\n\n',{headers:{'content-type':'text/event-stream'}});
 let req;try {const result=new Promise((resolve,reject)=>{req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}]}));});await barrier;const start=performance.now();await new Promise(r=>setTimeout(r,100));assert.ok(performance.now()-start<1000,'HTTP refresh blocked the event loop');child.send('release');await once(child,'exit');assert.equal(await result,200);assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'rotated');}
 finally {req?.destroy();accountPool.selectCandidate=oldSelect;globalThis.fetch=oldFetch;if(child?.connected)child.send('release');if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'exit');if(handling)await handling;repo.update(a.id,{status:'disabled'});}
});
test('disconnect before a pending 401 is handled never starts refresh', {timeout:5000},async()=>{
 const a=create('before401',Date.now()+3600000);let entered,release;const barrier=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({cancel(){entered();return gate;}}),{status:401});};
 let req;try {req=request();await barrier;req.destroy();await new Promise(r=>setTimeout(r,50));release();await handling;assert.equal(calls,1);assert.equal(getDb().prepare('SELECT count(*) AS n FROM oauth_refresh_intents WHERE account_id=?').get(a.id).n,0);} finally {release();req?.destroy();globalThis.fetch=old;repo.update(a.id,{status:'disabled'});}
});
test('disconnect after refresh starts still persists the rotated credential', {timeout:5000},async()=>{
 const a=create('disconnect',Date.now()-1);let entered,release;const barrier=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const old=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;entered();await gate;return new Response(JSON.stringify({access_token:'new',refresh_token:'new-refresh',expires_in:3600}));};
 let req;try {req=request();await barrier;req.destroy();await new Promise(r=>setTimeout(r,50));release();await drainTokenRefreshes();assert.equal(calls,1);assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'new-refresh');} finally {release();req?.destroy();globalThis.fetch=old;}
});
