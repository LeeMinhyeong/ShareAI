import { test } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {resolveAuth}=await import('../src/upstream/tokens.ts');
const repo=new AccountRepository();
const credentials=(accessToken,refreshToken,expiresAt=Date.now()+3600000)=>JSON.stringify({kind:'oauth',accessToken,refreshToken,expiresAt,accountId:'workspace'});

test('old 401 refreshes administrator replacement with same access token', async()=>{
  const a=repo.create({name:'stale-401',provider:'openai',credentialType:'oauth',credentials:credentials('same','old-refresh')});
  const auth=await resolveAuth(a); repo.update(a.id,{credentials:credentials('same','admin-refresh')});
  const oldFetch=globalThis.fetch; let calls=0;
  try { globalThis.fetch=async(_url,opts)=>{calls++; assert.equal(new URLSearchParams(opts.body).get('refresh_token'),'admin-refresh'); return new Response(JSON.stringify({access_token:'unexpected',refresh_token:'next',expires_in:3600}));};
    const retry=await resolveAuth(auth.observedAccount,{forceRefresh:true,rejectedToken:auth.token});
    assert.equal(calls,1); assert.equal(retry.token,'unexpected'); assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'next');
  } finally {globalThis.fetch=oldFetch;}
});

test('late 401 after internal same-access refresh does not rotate again', async()=>{
  const a=repo.create({name:'late-same',provider:'openai',credentialType:'oauth',credentials:credentials('same','late-old')});
  const first=await resolveAuth(a), second=await resolveAuth(a); const oldFetch=globalThis.fetch; let calls=0;
  try { globalThis.fetch=async()=>{calls++; return new Response(JSON.stringify({access_token:'same',refresh_token:'late-new',expires_in:3600}));};
    await resolveAuth(first.observedAccount,{forceRefresh:true,rejectedToken:first.token});
    const retry=await resolveAuth(second.observedAccount,{forceRefresh:true,rejectedToken:second.token});
    assert.equal(calls,1); assert.equal(retry.token,'same'); assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'late-new');
  } finally {globalThis.fetch=oldFetch;}
});

test('late 401 after admin replacement and internal refresh does not rotate again', async()=>{
  const a=repo.create({name:'admin-then-refresh',provider:'openai',credentialType:'oauth',credentials:credentials('same','before-admin')});
  const old=await resolveAuth(a); repo.update(a.id,{credentials:credentials('same','after-admin')});
  const oldFetch=globalThis.fetch; let calls=0;
  try {globalThis.fetch=async()=>{calls++; return new Response(JSON.stringify({access_token:'same',refresh_token:'after-refresh',expires_in:3600}));};
    await resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token});
    await resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token});
    assert.equal(calls,1); assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'after-refresh');
  } finally {globalThis.fetch=oldFetch;}
});

test('late 401 does not reuse an already expired internally rotated same token', async()=>{
  const a=repo.create({name:'expired-same-rotation',provider:'openai',credentialType:'oauth',credentials:credentials('same','short-old')});
  const old=await resolveAuth(a); const oldFetch=globalThis.fetch; let calls=0;
  try {globalThis.fetch=async()=>{calls++; return new Response(JSON.stringify({access_token:'same',refresh_token:'short-new',expires_in:1}));};
    await resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token});
    const realNow=Date.now;
    try {Date.now=()=>realNow()+2000; await assert.rejects(resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token}));}
    finally {Date.now=realNow;}
    assert.equal(calls,1);
  } finally {globalThis.fetch=oldFetch;}
});

test('stale 401 refreshes a different expired replacement token', async()=>{
  const a=repo.create({name:'stale-expired',provider:'openai',credentialType:'oauth',credentials:credentials('old','expired-old')});
  const old=await resolveAuth(a); repo.update(a.id,{credentials:credentials('new','expired-new',1)}); const oldFetch=globalThis.fetch; let calls=0;
  try { globalThis.fetch=async()=>{calls++; return new Response(JSON.stringify({access_token:'fresh',refresh_token:'expired-next',expires_in:3600}));};
    const retry=await resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token});
    assert.equal(calls,1); assert.equal(retry.token,'fresh');
  } finally {globalThis.fetch=oldFetch;}
});

test('stale 401 never returns a different expired token without refresh capability', async()=>{
  const a=repo.create({name:'stale-expired-no-refresh',provider:'openai',credentialType:'oauth',credentials:credentials('old','old-norefresh')});
  const old=await resolveAuth(a); repo.update(a.id,{credentials:credentials('new',null,1)});
  await assert.rejects(resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token}));
});

test('successful refresh with unchanged access token invalidates prior results', async()=>{
  const a=repo.create({name:'same-token-rotation',provider:'openai',credentialType:'oauth',credentials:credentials('same','rotation-old')});
  const old=await resolveAuth(a); const oldFetch=globalThis.fetch;
  try {globalThis.fetch=async()=>new Response(JSON.stringify({access_token:'same',refresh_token:'rotation-new',expires_in:3600}));
    const refreshed=await resolveAuth(old.observedAccount,{forceRefresh:true,rejectedToken:old.token});
    assert.ok(refreshed.observedAccount.stateRevision>old.observedAccount.stateRevision);
    assert.equal(repo.recordObservedFailure(a.id,401,'stale',old.observedAccount,old.token),false);
    assert.equal(repo.markUsed(a.id,old.observedAccount,old.token,false),false);
    assert.equal(repo.findById(a.id).status,'active');
    assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'rotation-new');
  } finally {globalThis.fetch=oldFetch;}
});

test('administrator same-access credential replacement wins against in-flight refresh', async()=>{
  const a=repo.create({name:'admin-same-race',provider:'openai',credentialType:'oauth',credentials:credentials('same','race-old')});
  let release, started;
  const entered=new Promise(resolve=>started=resolve), gate=new Promise(resolve=>release=resolve);
  const oldFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>{started(); await gate; return new Response(JSON.stringify({access_token:'same',refresh_token:'race-rotated',expires_in:3600}));};
    const pending=resolveAuth(a,{forceRefresh:true,rejectedToken:'same'}); await entered;
    repo.update(a.id,{credentials:credentials('same','race-admin')}); release();
    await assert.rejects(pending);
    const saved=repo.findById(a.id);
    assert.equal(saved.status,'active'); assert.equal(JSON.parse(saved.credentials).refreshToken,'race-admin');
  } finally {release();globalThis.fetch=oldFetch;}
});
