import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
const {resolveAuth}=await import('../src/upstream/tokens.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const repo=new AccountRepository();
const creds=(accessToken,refreshToken)=>JSON.stringify({kind:'oauth',accessToken,refreshToken,expiresAt:Date.now()+3600000,accountId:'workspace'});
const req=()=>({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}});
const res=()=>{const r=new EventEmitter(); r.status=function(s){this.statusCode=s;return this}; r.json=function(b){this.body=b}; return r};

test('a stale 401 on the same access token refreshes the new generation before retry',async()=>{
 const a=repo.create({name:'latest-same',provider:'openai',credentialType:'oauth',credentials:creds('same','old-latest')});
 const oldFetch=globalThis.fetch, oldSelect=accountPool.selectAccount, calls=[];
 try {
  accountPool.selectAccount=async()=>a;
  globalThis.fetch=async(url,opts)=>{
   if(String(url).includes('oauth/token')) {calls.push(String(opts.body)); return new Response(JSON.stringify({access_token:'rotated',refresh_token:'rotated-latest',expires_in:3600}));}
   calls.push(opts.headers.authorization);
   if(calls.length===1){repo.update(a.id,{credentials:creds('same','new-latest')}); return new Response('',{status:401});}
   return new Response('data: {"type":"response.completed","response":{"id":"r"}}\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const r=res(); await forwardChat(req(),r);
  assert.equal(calls.length,3); assert.equal(calls[0],'Bearer same'); assert.match(calls[1],/new-latest/); assert.equal(calls[2],'Bearer rotated');
  assert.equal(r.statusCode,undefined); assert.equal(repo.findById(a.id).status,'active');
 } finally {globalThis.fetch=oldFetch;accountPool.selectAccount=oldSelect;}
});

test('normal request joins an in-process forced refresh before expiry without cooldown',async()=>{
 const a=repo.create({name:'join-forced',provider:'openai',credentialType:'oauth',credentials:creds('valid','join-token')});
 const oldFetch=globalThis.fetch, oldSelect=accountPool.selectAccount; let release,started,fetches=0;
 const gate=new Promise(r=>release=r), entered=new Promise(r=>started=r);
 try {
  accountPool.selectAccount=async()=>repo.findById(a.id);
  globalThis.fetch=async(url)=>{if(String(url).includes('oauth/token')){fetches++;started();await gate;return new Response(JSON.stringify({access_token:'fresh',refresh_token:'fresh-join',expires_in:3600}));} return new Response('data: {"type":"response.completed","response":{"id":"r"}}\n\n',{headers:{'content-type':'text/event-stream'}});};
  const first=resolveAuth(a,{forceRefresh:true,rejectedToken:'valid'}); await entered;
  const r=res(); const second=forwardChat(req(),r); await new Promise(r=>setTimeout(r,30)); release(); await Promise.all([first,second]);
  assert.equal(fetches,1); assert.equal(r.statusCode,undefined); assert.equal(repo.findById(a.id).status,'active'); assert.equal(accountPool.cooldownOf(a.id),0);
 } finally {release();globalThis.fetch=oldFetch;accountPool.selectAccount=oldSelect;}
});

test('foreign or uncertain refresh intent is rejected without account cooldown',async()=>{
 const a=repo.create({name:'foreign-intent',provider:'openai',credentialType:'oauth',credentials:creds('valid-foreign','foreign-token')});
 repo.claimRefresh(a.id,a.credentials);
 const oldFetch=globalThis.fetch, oldSelect=accountPool.selectAccount; let calls=0;
 try {accountPool.selectAccount=async()=>a; globalThis.fetch=async()=>{calls++;throw new Error('must not call upstream')};
  const r=res(); await forwardChat(req(),r);
  assert.equal(r.statusCode,503); assert.equal(calls,0); assert.equal(repo.findById(a.id).status,'active'); assert.equal(accountPool.cooldownOf(a.id),0);
 } finally {globalThis.fetch=oldFetch;accountPool.selectAccount=oldSelect;}
});

test('expired credentials with a foreign intent are not resubmitted or cooled down',async()=>{
 const a=repo.create({name:'foreign-expired',provider:'openai',credentialType:'oauth',credentials:creds('valid-expired','foreign-expired-token')});
 repo.claimRefresh(a.id,a.credentials);
 const oldFetch=globalThis.fetch, oldSelect=accountPool.selectAccount; let calls=0;
 try {accountPool.selectAccount=async()=>a; globalThis.fetch=async()=>{calls++;throw new Error('must not call upstream')};
  repo.update(a.id,{credentials:JSON.stringify({...JSON.parse(a.credentials),expiresAt:1})});
  const r=res(); await forwardChat(req(),r);
  assert.equal(r.statusCode,503); assert.match(r.body.error.message,/uncertain/); assert.equal(calls,0);
  assert.equal(repo.findById(a.id).status,'active'); assert.equal(accountPool.cooldownOf(a.id),0);
 } finally {globalThis.fetch=oldFetch;accountPool.selectAccount=oldSelect;}
});
