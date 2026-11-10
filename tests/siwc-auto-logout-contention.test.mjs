import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';

const dir = mkdtempSync(join(process.env.TMPDIR, 'siwc-auto-logout-'));
const file = join(dir, 'db.sqlite');
process.env.DATABASE_URL = `sqlite:${file}`;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'synthetic-admin-key-for-testing';
const { getDb, closeDatabase } = await import('../src/db/client.ts');
const { hashApiKey, CredentialVault } = await import('../src/utils/encryption.ts');
const { SiwcStore } = await import('../src/upstream/siwc-store.ts');
const { accountPool } = await import('../src/account-pool/manager.ts');
const { default: v1 } = await import('../src/routes/v1.ts');
const { default: admin } = await import('../src/routes/admin.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db = getDb();
db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('a','a'),('b','b'); INSERT INTO siwc_access_policy VALUES ('a',1,'all');");
db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit) VALUES ('u',?,'u','u@example.invalid','free',100)").run(hashApiKey('synthetic-key'));
const store = new SiwcStore(db,new CredentialVault());
const credential = {issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'synthetic',refreshToken:'refresh',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access','chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()};
store.create('a',credential); store.create('b',{...credential,clientId:'b',refreshToken:'b-refresh'});
const app=express(); app.use(express.json()); app.use('/v1',v1); app.use('/admin',admin);
const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
const lock = async () => { const child=fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']}); await once(child,'message'); return child; };
const stop = async child => { if(child && child.exitCode===null && child.signalCode===null) { child.kill(); await once(child,'exit'); } };
const request = (path,key,body) => { const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{res.resume();}); req.on('error',()=>{}); req.end(JSON.stringify(body)); return req; };

test('automatic HTTP selection keeps timers and disconnect responsive during external write lock', {timeout:8000}, async () => {
  const original=accountPool.selectCandidate, originalFetch=globalThis.fetch; let child, tick, calls=0, req;
  const timer=new Promise(resolve=>{tick=resolve;});
  accountPool.selectCandidate=async function(...args) { child=await lock(); const start=Date.now(); setTimeout(()=>{req.destroy(); tick(Date.now()-start);},100); return original.apply(this,args); };
  globalThis.fetch=async()=>{calls++; throw Error('unexpected provider');};
  try {
    req=request('/v1/chat/completions','synthetic-key',{model:'gpt-5',messages:[{role:'user',content:'hi'}]});
    const elapsed=await timer;
    assert.ok(elapsed<300,`selection blocked event loop ${elapsed}ms`);
    await new Promise(resolve=>setTimeout(resolve,750));
    assert.equal(calls,0,'disconnected request invoked provider');
  } finally { req?.destroy(); await stop(child); accountPool.selectCandidate=original; globalThis.fetch=originalFetch; }
});

test('admin HTTP logout waits without blocking and fences the credential atomically', {timeout:8000}, async () => {
  const child=await lock(), originalFetch=globalThis.fetch; let calls=0;
  globalThis.fetch=async url=>{calls++; return url.includes('openid-configuration') ? Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}) : new Response(null,{status:200});};
  try {
    const start=Date.now();
    const response=new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/admin/siwc/accounts/b/logout',method:'POST',headers:{authorization:`Bearer ${process.env.ADMIN_API_KEY}`,'content-type':'application/json'}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end('{}');});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(Date.now()-start<300,`logout blocked event loop ${Date.now()-start}ms`);
    assert.ok(store.read('b'),'credential changed while lock held');
    assert.equal(calls,0);
    const result=await response;
    assert.equal(result.status,200); assert.deepEqual(result.body,{localSignedOut:true,remoteRevoked:true});
    assert.equal(store.read('b'),null); assert.equal(store.readRegistrationSnapshot('b').identity.clientId,'b');
  } finally { await stop(child); globalThis.fetch=originalFetch; }
});
test('post-revocation verification also yields to timers under a write lock', {timeout:8000}, async () => {
  db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run('c','c');
  store.create('c',{...credential,clientId:'c-post',refreshToken:'c-refresh'});
  const originalFetch=globalThis.fetch; let child, resolveTick;
  const tick=new Promise(resolve=>{resolveTick=resolve;});
  globalThis.fetch=async url=>{
    if (url.includes('openid-configuration')) return Response.json({revocation_endpoint:'https://auth.openai.com/revoke'});
    child=await lock(); const start=Date.now(); setTimeout(()=>resolveTick(Date.now()-start),100);
    return new Response(null,{status:200});
  };
  try {
    const response=new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/admin/siwc/accounts/c/logout',method:'POST',headers:{authorization:`Bearer ${process.env.ADMIN_API_KEY}`,'content-type':'application/json'}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end('{}');});
    const elapsed=await tick; assert.ok(elapsed<300,`verification blocked event loop ${elapsed}ms`);
    assert.equal(store.read('c'),null);
    const result=await response; assert.equal(result.status,200); assert.deepEqual(result.body,{localSignedOut:true,remoteRevoked:true});
  } finally { await stop(child); globalThis.fetch=originalFetch; }
});
test.after(async()=>{await new Promise(resolve=>server.close(resolve)); closeDatabase(); rmSync(dir,{recursive:true,force:true});});
