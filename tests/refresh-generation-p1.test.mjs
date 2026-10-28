import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
Object.assign(process.env, {NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {resolveAuth}=await import('../src/upstream/tokens.ts');
const repo=new AccountRepository();
const creds=(accessToken,refreshToken)=>JSON.stringify({kind:'oauth',accessToken,refreshToken,expiresAt:Date.now()+3600000,accountId:'workspace'});
const response=()=>{const res=new EventEmitter(); res.status=function(s){this.statusCode=s;return this;}; res.json=function(body){this.body=body;}; return res;};
const request=()=>({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}});

test('non-credential admin update during 401 still refreshes rejected credentials', async()=>{
  const a=repo.create({name:'non-credential-update',provider:'openai',credentialType:'oauth',credentials:creds('old-access','old-refresh')});
  const oldSelect=accountPool.selectAccount, oldFetch=globalThis.fetch, calls=[];
  try {
    accountPool.selectAccount=async()=>a;
    globalThis.fetch=async(url,opts)=>{
      if(String(url).includes('oauth/token')) {calls.push('refresh'); return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}));}
      calls.push(opts.headers.authorization);
      if(calls.length===1) repo.update(a.id,{lastError:'admin note'});
      return new Response('',{status:401});
    };
    const res=response(); await forwardChat(request(),res);
    assert.deepEqual(calls,['Bearer old-access','refresh','Bearer new-access']);
    assert.equal(res.statusCode,401);
  } finally {accountPool.selectAccount=oldSelect;globalThis.fetch=oldFetch;}
});

test('replacement generation refresh is independent and old failure cannot cool it down', async()=>{
  const a=repo.create({name:'parallel-generations',provider:'openai',credentialType:'oauth',credentials:creds('old-access','old-refresh-parallel')});
  const oldSelect=accountPool.selectAccount, oldFetch=globalThis.fetch;
  let releaseOld, signalOld, signalNew;
  const oldGate=new Promise(r=>releaseOld=r), oldStarted=new Promise(r=>signalOld=r), newStarted=new Promise(r=>signalNew=r);
  const calls=[];
  try {
    accountPool.selectAccount=async()=>repo.findById(a.id);
    globalThis.fetch=async(url,opts)=>{
      if(String(url).includes('oauth/token')) {
        const body=String(opts.body); calls.push(body);
        if(body.includes('old-refresh-parallel')) {signalOld(); await oldGate; return new Response('',{status:500});}
        signalNew(); return new Response(JSON.stringify({access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:3600}));
      }
      if(opts.headers.authorization==='Bearer rotated-access') return new Response('data: {"type":"response.completed","response":{"id":"r"}}\n\n',{headers:{'content-type':'text/event-stream'}});
      return new Response('',{status:401});
    };
    const oldRes=response(), oldRequest=forwardChat(request(),oldRes); await oldStarted;
    repo.update(a.id,{credentials:creds('new-access','new-refresh-parallel')});
    const newRes=response(), newRequest=forwardChat(request(),newRes);
    const independent=await Promise.race([newStarted.then(()=>true),new Promise(r=>setTimeout(()=>r(false),1000))]);
    if(independent) await newRequest;
    releaseOld(); await Promise.all([oldRequest,newRequest]);
    assert.equal(independent,true,'new generation must start its own refresh before old refresh settles');
    assert.equal(calls.length,2);
    assert.equal(oldRes.statusCode,502);
    assert.equal(newRes.statusCode,undefined);
    assert.equal(repo.findById(a.id).status,'active');
    assert.equal(accountPool.cooldownOf(a.id),0);
    assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'rotated-refresh');
  } finally {releaseOld();accountPool.selectAccount=oldSelect;globalThis.fetch=oldFetch;}
});

test('credential type ABA during refresh cannot commit stale rotation', async()=>{
  const a=repo.create({name:'type-aba',provider:'openai',credentialType:'oauth',credentials:creds('aba-access','aba-refresh')});
  let release, started; const gate=new Promise(r=>release=r), entered=new Promise(r=>started=r);
  const oldFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{started(); await gate; return new Response(JSON.stringify({access_token:'wrong',refresh_token:'wrong-refresh',expires_in:3600}));};
    const pending=resolveAuth(a,{forceRefresh:true,rejectedToken:'aba-access'}); await entered;
    repo.update(a.id,{credentialType:'api_key'}); repo.update(a.id,{credentialType:'oauth'}); release();
    await assert.rejects(pending);
    assert.equal(repo.findById(a.id).credentials,a.credentials);
  } finally {release();globalThis.fetch=oldFetch;}
});
