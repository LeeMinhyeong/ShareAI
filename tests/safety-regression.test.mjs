import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {resolveAuth}=await import('../src/upstream/tokens.ts');
const {refreshTokens}=await import('../src/upstream/oauth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const repo=new AccountRepository();
const creds=(token,refresh,exp=Date.now()+3600000)=>JSON.stringify({kind:'oauth',accessToken:token,refreshToken:refresh,expiresAt:exp,accountId:'workspace'});
const create=(name,credentials)=>repo.create({name,provider:'openai',credentialType:'oauth',credentials});
function response(){const r=new EventEmitter(); r.status=function(s){this.code=s;return this}; r.json=function(body){this.body=body;this.writableEnded=true;return this}; return r;}
const req={user:{id:'user'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}};

test('in-flight request failure preserves administrator disabled status and error',async()=>{
 const a=create('request',creds('request-token','request-refresh')); let start,release; const entered=new Promise(r=>start=r), gate=new Promise(r=>release=r); const old=globalThis.fetch;
 globalThis.fetch=async()=>{start();await gate;return new Response('',{status:403})};
 try {const pending=forwardChat(req,response());await entered;repo.update(a.id,{status:'disabled',lastError:'administrator'});release();await pending;const saved=repo.findById(a.id);assert.equal(saved.status,'disabled');assert.equal(saved.lastError,'administrator');} finally {release();globalThis.fetch=old;}
});

test('successful in-flight request preserves newer admin error on quota state',async()=>{
 const a=create('success-admin',creds('success-token','success-refresh'));repo.update(a.id,{status:'quota_exceeded'});let start,release;const entered=new Promise(r=>start=r),gate=new Promise(r=>release=r);const old=globalThis.fetch;
 globalThis.fetch=async()=>{start();await gate;return new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}})};
 try{const p=forwardChat(req,response());await entered;repo.update(a.id,{lastError:'admin update'});release();await p;const saved=repo.findById(a.id);assert.equal(saved.status,'quota_exceeded');assert.equal(saved.lastError,'admin update');}finally{release();globalThis.fetch=old;repo.delete(a.id);}
});

test('refresh failure preserves newer admin lastError even when status remains active',async()=>{
 const a=create('refresh-admin',creds('old','refresh-admin',1));let start,release;const entered=new Promise(r=>start=r),gate=new Promise(r=>release=r);const old=globalThis.fetch;
 globalThis.fetch=async()=>{start();await gate;return new Response('',{status:500})};
 try{const p=resolveAuth(a);await entered;repo.update(a.id,{lastError:'admin update'});release();await assert.rejects(p);const saved=repo.findById(a.id);assert.equal(saved.status,'active');assert.equal(saved.lastError,'admin update');}finally{release();globalThis.fetch=old;repo.delete(a.id);}
});

test('late 403 cannot mark replacement credentials as invalid',async()=>{
 const a=create('credentials-race',creds('old-403','old-403-refresh'));let start,release;const entered=new Promise(r=>start=r),gate=new Promise(r=>release=r);const old=globalThis.fetch;
 globalThis.fetch=async()=>{start();await gate;return new Response('',{status:403})};
 try{const p=forwardChat(req,response());await entered;repo.update(a.id,{credentials:creds('replacement','replacement-refresh')});release();await p;const saved=repo.findById(a.id);assert.equal(saved.status,'active');assert.equal(saved.lastError,null);}finally{release();globalThis.fetch=old;repo.delete(a.id);}
});

test('malformed refresh JSON does not expose response token in error',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>new Response('SECRET_RESPONSE_TOKEN');
 try{await assert.rejects(refreshTokens('openai',JSON.parse(creds('old','malformed'))),e=>!String(e.stack).includes('SECRET_'));}finally{globalThis.fetch=old;}
});

test('old 401 retries using latest token without rotating it',async()=>{
 const a=create('stale-401',creds('old-401','old-refresh')); let start,release;const entered=new Promise(r=>start=r),gate=new Promise(r=>release=r);const old=globalThis.fetch;let refreshCalls=0;const seen=[];
 globalThis.fetch=async(url,options)=>{if(String(url).includes('/oauth/token')){refreshCalls++;return new Response(JSON.stringify({access_token:'unneeded',refresh_token:'unneeded-refresh',expires_in:3600}))} const token=options.headers.authorization;seen.push(token);if(seen.length===1){start();await gate;return new Response('',{status:401})}return new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}})};
 try{const res=response();const p=forwardChat(req,res);await entered;repo.update(a.id,{credentials:creds('new-401','new-refresh')});release();await p;assert.equal(refreshCalls,0);assert.deepEqual(seen,['Bearer old-401','Bearer new-401']);assert.equal(res.body.choices[0].finish_reason,'stop');}finally{release();globalThis.fetch=old;}
});
