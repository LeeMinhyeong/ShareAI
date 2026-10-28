import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
const {resolveAuth}=await import('../src/upstream/tokens.ts');
const repo=new AccountRepository();
test('resolved credentials carry their actual administrative generation into failure recording', async () => {
  const a=repo.create({name:'new-generation',provider:'openai',credentialType:'api_key',credentials:'old'});
  repo.update(a.id,{credentials:'new'});
  const auth=await resolveAuth(a); const pool=new AccountPoolManager();
  assert.equal(auth.token,'new');
  pool.recordFailure(a.id,{status:401,message:'new rejected'},auth.observedAccount,auth.token);
  assert.equal(repo.findById(a.id).status,'error');
});
test('same-token admin ABA after authentication does not accept stale failure', async () => {
  const a=repo.create({name:'aba',provider:'openai',credentialType:'api_key',credentials:'same'});
  const auth=await resolveAuth(a); const pool=new AccountPoolManager();
  repo.update(a.id,{credentials:'same'});
  pool.recordFailure(a.id,{status:401,message:'stale'},auth.observedAccount,auth.token);
  assert.equal(repo.findById(a.id).status,'active');
});
test('concurrent observations of same generation both record failures', async () => {
  const a=repo.create({name:'concurrent',provider:'openai',credentialType:'api_key',credentials:'key'});
  const [one,two]=await Promise.all([resolveAuth(a),resolveAuth(a)]); const pool=new AccountPoolManager();
  pool.recordFailure(a.id,{status:500,message:'first'},one.observedAccount,one.token);
  pool.recordFailure(a.id,{status:401,message:'second'},two.observedAccount,two.token);
  assert.equal(repo.findById(a.id).status,'error');
});

test('forward records 401 against the credential actually sent, but not after admin ABA', async () => {
  const {accountPool}=await import('../src/account-pool/manager.ts');
  const {forwardChat}=await import('../src/upstream/forward-chat.ts');
  const {EventEmitter}=await import('node:events');
  const oldSelect=accountPool.selectAccount, oldFetch=globalThis.fetch;
  try {
    for (const aba of [false,true]) {
      const a=repo.create({name:`forward-${aba}`,provider:'openai',credentialType:'api_key',credentials:'sk-old'});
      accountPool.selectAccount=async()=>{repo.update(a.id,{credentials:'sk-new'}); return a;};
      globalThis.fetch=async (_url,opts)=>{
        assert.equal(opts.headers.authorization,'Bearer sk-new');
        if (aba) repo.update(a.id,{credentials:'sk-new'});
        return new Response('',{status:401});
      };
      const res=new EventEmitter(); res.status=function(s){this.statusCode=s;return this;}; res.json=function(body){this.body=body;};
      await forwardChat({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}},res);
      assert.equal(res.statusCode,401);
      assert.equal(repo.findById(a.id).status,aba?'active':'error');
    }
  } finally {accountPool.selectAccount=oldSelect; globalThis.fetch=oldFetch;}
});

test('refresh result carries the revision used for a rejected rotated token', async () => {
  const {accountPool}=await import('../src/account-pool/manager.ts');
  const {forwardChat}=await import('../src/upstream/forward-chat.ts');
  const {EventEmitter}=await import('node:events');
  const oldSelect=accountPool.selectAccount, oldFetch=globalThis.fetch;
  const credentials=JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:'unique-refresh',expiresAt:1,accountId:'workspace'});
  const a=repo.create({name:'forward-refresh',provider:'openai',credentialType:'oauth',credentials});
  try {
    accountPool.selectAccount=async()=>{repo.update(a.id,{status:'active'}); return a;};
    globalThis.fetch=async (url,opts)=>{
      if (String(url).includes('oauth/token')) return new Response(JSON.stringify({access_token:'rotated',expires_in:3600}));
      assert.equal(opts.headers.authorization,'Bearer rotated'); return new Response('',{status:401});
    };
    const res=new EventEmitter(); res.status=function(s){this.statusCode=s;return this;}; res.json=function(body){this.body=body;};
    await forwardChat({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}},res);
    assert.equal(res.statusCode,401); assert.equal(repo.findById(a.id).status,'error');
  } finally {accountPool.selectAccount=oldSelect; globalThis.fetch=oldFetch;}
});

test('401 triggers refresh and retries with the refreshed credential generation', async () => {
  const {accountPool}=await import('../src/account-pool/manager.ts');
  const {forwardChat}=await import('../src/upstream/forward-chat.ts');
  const {EventEmitter}=await import('node:events');
  const a=repo.create({name:'actual-401-refresh',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'initial',refreshToken:'actual-refresh',expiresAt:Date.now()+3600000,accountId:'workspace'})});
  const oldSelect=accountPool.selectAccount, oldFetch=globalThis.fetch; const calls=[];
  try {
    accountPool.selectAccount=async()=>a;
    globalThis.fetch=async (url,opts)=>{
      if (String(url).includes('oauth/token')) { calls.push('refresh'); return new Response(JSON.stringify({access_token:'rotated',refresh_token:'new-refresh',expires_in:3600})); }
      calls.push(opts.headers.authorization); return new Response('',{status:401});
    };
    const res=new EventEmitter(); res.status=function(s){this.statusCode=s;return this;}; res.json=function(body){this.body=body;};
    await forwardChat({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}},res);
    assert.deepEqual(calls,['Bearer initial','refresh','Bearer rotated']);
    assert.equal(res.statusCode,401); assert.equal(repo.findById(a.id).status,'error');
    assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'new-refresh');
  } finally {accountPool.selectAccount=oldSelect; globalThis.fetch=oldFetch;}
});

test('old 401 refreshes administrator replacement with the same access token', async () => {
  const {accountPool}=await import('../src/account-pool/manager.ts');
  const {forwardChat}=await import('../src/upstream/forward-chat.ts');
  const {EventEmitter}=await import('node:events');
  const creds=refreshToken=>JSON.stringify({kind:'oauth',accessToken:'same',refreshToken,expiresAt:Date.now()+3600000,accountId:'workspace'});
  const a=repo.create({name:'forward-stale-401',provider:'openai',credentialType:'oauth',credentials:creds('old-forward')});
  const oldSelect=accountPool.selectAccount, oldFetch=globalThis.fetch; const calls=[];
  try {
    accountPool.selectAccount=async()=>a;
    globalThis.fetch=async (url,opts)=>{
      if (String(url).includes('oauth/token')) {calls.push('refresh'); assert.equal(new URLSearchParams(opts.body).get('refresh_token'),'admin-forward'); return new Response(JSON.stringify({access_token:'bad',refresh_token:'bad',expires_in:3600}));}
      calls.push(opts.headers.authorization);
      if (calls.length===1) repo.update(a.id,{credentials:creds('admin-forward')});
      return new Response('',{status:401});
    };
    const res=new EventEmitter(); res.status=function(s){this.statusCode=s;return this;}; res.json=function(body){this.body=body;};
    await forwardChat({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hi'}]}},res);
    assert.deepEqual(calls,['Bearer same','refresh','Bearer bad']); assert.equal(res.statusCode,401);
    assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'bad');
    assert.equal(repo.findById(a.id).status,'error');
  } finally {accountPool.selectAccount=oldSelect; globalThis.fetch=oldFetch;}
});
