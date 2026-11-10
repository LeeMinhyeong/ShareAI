import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {chatStream,responseStream} from './phase4-protocol-fixtures.mjs';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'selection-race-')), file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(),repo=new AccountRepository(),users=new UserRepository();
const user=users.create({apiKeyHash:hashApiKey('fixture-key'),name:'test',email:'test@example.invalid',tier:'pro',dailyLimit:100});
const a=repo.create({name:'first',provider:'openai',credentialType:'api_key',credentials:'sk-first',priority:0,dailyQuota:1});
const b=repo.create({name:'second',provider:'openai',credentialType:'api_key',credentials:'sk-second',priority:10,dailyQuota:1});
let handling;const app=express();app.use(express.json());app.post('/v1/chat/completions',authenticateUser,(req,res)=>{handling=forwardChat(req,res);});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
const worker=fileURLToPath(new URL('./phase4-selection-race-worker.mjs',import.meta.url));
const originalSelect=accountPool.selectCandidate.bind(accountPool), originalFetch=globalThis.fetch;
let calls=[];globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};
function request(body,key='fixture-key'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end(JSON.stringify(body));});}
after(async()=>{accountPool.selectCandidate=originalSelect;globalThis.fetch=originalFetch;await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('cross-process last-slot race chooses another ordinary account before dispatch', {timeout:30000},async()=>{
 let blocked=false;
 accountPool.selectCandidate=async (...args)=>{const selected=await originalSelect(...args);if(!blocked){blocked=true;assert.equal(selected.id,a.id);const child=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker,file,a.id],{env:process.env,encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);}return selected;};
 const before=users.getTodayUsageCount(user.id);
 const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});await handling;
 assert.equal(r.status,200,r.text);assert.deepEqual(calls,['Bearer sk-second']);assert.equal(users.getTodayUsageCount(user.id),before+1);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(a.id).used,1);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(b.id).used,1);
});
test('cross-process 429 after selection chooses B before any A reservation or dispatch', {timeout:30000},async()=>{
 repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});
 const c=repo.create({name:'fenced',provider:'openai',credentialType:'api_key',credentials:'sk-fenced',priority:0});
 const d=repo.create({name:'replacement',provider:'openai',credentialType:'api_key',credentials:'sk-replacement',priority:10});
 const received=[];
 const provider=http.createServer((req,res)=>{received.push(req.headers.authorization);req.resume();res.writeHead(200,{'content-type':'text/event-stream'});res.end(chatStream);});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const port=provider.address().port;assert.notEqual(port,20128);
 globalThis.fetch=(_url,opts)=>originalFetch(`http://127.0.0.1:${port}/`,opts);
 let blocked=false;
 accountPool.selectCandidate=async (...args)=>{const selected=await originalSelect(...args);if(!blocked){blocked=true;assert.equal(selected.id,c.id);
   // Another process arms a 30s v2 restriction through the real store (ADR 0008), as its 429 settlement would.
   const store=new URL('../src/db/account-429-v2-store.ts',import.meta.url).href;
   const script=`import {createRequire} from 'node:module';import {arm429V2} from ${JSON.stringify(store)};const D=createRequire(${JSON.stringify(import.meta.url)})('better-sqlite3');const db=new D(process.argv[1]);db.transaction(()=>arm429V2(db,'upstream',process.argv[2],30000)).immediate();db.close();`;
   const child=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script,file,c.id],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);
 }return selected;};
 try {
  const before=users.getTodayUsageCount(user.id);
  const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});await handling;
  assert.equal(r.status,200,r.text);assert.deepEqual(received,['Bearer sk-replacement']);
  assert.equal(users.getTodayUsageCount(user.id),before+1);
  assert.equal(db.prepare('SELECT count(*) n FROM account_daily_reservations WHERE account_id=?').get(c.id).n,0);
  assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(d.id).used,1);
  assert.equal(db.prepare('SELECT count(*) n FROM ordinary_account_attempts WHERE account_id IN (?,?)').get(c.id,d.id).n,0);
 } finally {accountPool.selectCandidate=originalSelect;globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};repo.update(c.id,{status:'disabled'});repo.update(d.id,{status:'disabled'});await new Promise(r=>provider.close(r));}
});
test('OPEN introduced by another process during OAuth refresh never selects B', {timeout:30000},async()=>{
 repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});
 const first=repo.create({name:'refresh-open',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old-token',refreshToken:'refresh-fixture',accountId:'workspace',expiresAt:Date.now()+1000}),priority:0});
 const second=repo.create({name:'refresh-replacement',provider:'openai',credentialType:'api_key',credentials:'sk-replacement-fixture',priority:10});
 accountPool.selectCandidate=originalSelect; const providerCalls=[];
 globalThis.fetch=async (url,opts)=>{
  if(String(url).includes('oauth/token')) {
   const script=`const D=require('better-sqlite3');const db=new D(process.argv[1]);db.prepare('INSERT INTO ordinary_account_attempts(account_id,attempt_id) VALUES (?,?)').run(process.argv[2],'other-attempt');db.close()`;
   const child=spawnSync(process.execPath,['-e',script,file,first.id],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);
   return Response.json({access_token:'refreshed-token',refresh_token:'rotated-fixture',expires_in:3600});
  }
  providerCalls.push(opts.headers.authorization);return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});
 };
 try {
  const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});await handling;
  assert.equal(r.status,503,r.text);assert.deepEqual(providerCalls,[]);assert.doesNotMatch(r.text,/old-token|refreshed-token|refresh-fixture|replacement-fixture/);
 } finally {globalThis.fetch=originalFetch;repo.update(first.id,{status:'disabled'});repo.update(second.id,{status:'disabled'});}
});
test('credential revision changed after selection cannot fall back on OPEN', {timeout:30000},async()=>{
 const first=repo.create({name:'revision-open',provider:'openai',credentialType:'api_key',credentials:'sk-revision-old',priority:0});
 const second=repo.create({name:'revision-replacement',provider:'openai',credentialType:'api_key',credentials:'sk-revision-next',priority:10});
 let selections=0, providerCalls=0;
 globalThis.fetch=async()=>{providerCalls++;return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};
 accountPool.selectCandidate=async (...args)=>{const selected=await originalSelect(...args);selections++;assert.equal(selected.id,first.id);
  const script=`const D=require('better-sqlite3');const db=new D(process.argv[1]);db.prepare('UPDATE upstream_accounts SET credential_revision=credential_revision+1 WHERE id=?').run(process.argv[2]);db.prepare('INSERT INTO ordinary_account_attempts(account_id,attempt_id) VALUES (?,?)').run(process.argv[2],'other');db.close()`;
  const child=spawnSync(process.execPath,['-e',script,file,first.id],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);return selected;};
 try {const before=users.getTodayUsageCount(user.id);const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});await handling;
  assert.equal(r.status,503,r.text);assert.equal(selections,1);assert.equal(providerCalls,0);assert.equal(users.getTodayUsageCount(user.id),before+1);
  assert.equal(db.prepare('SELECT count(*) n FROM account_daily_reservations WHERE account_id IN (?,?)').get(first.id,second.id).n,0);
 } finally {accountPool.selectCandidate=originalSelect;globalThis.fetch=originalFetch;repo.update(first.id,{status:'disabled'});repo.update(second.id,{status:'disabled'});}
});
test('mixed candidate admission races stop after 16 total candidates', {timeout:60000},async()=>{
 const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
 const {CredentialVault}=await import('../src/utils/encryption.ts');
 db.exec('CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
 const store=new SiwcStore(db,new CredentialVault());const candidates=[];
 for(let i=0;i<17;i++) {
  if(i%2===0){const account=repo.create({name:`cap-${i}`,provider:'openai',credentialType:'api_key',credentials:`sk-cap-${i}`});candidates.push({kind:'upstream',id:account.id,account});}
  else {const id=`cap-siwc-${i}`;db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run(id,id);store.create(id,{issuer:'https://auth.openai.com',subject:id,clientId:`fixture-${i}`,accessToken:`siwc-cap-${i}`,idToken:'fixture',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});db.prepare("INSERT INTO siwc_access_policy VALUES (?,1,'all')").run(id);candidates.push({kind:'siwc',id});}
 }
 let selections=0;let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};
 accountPool.selectCandidate=async (_u,_m,_p,_s,opts)=>{
  const candidate=candidates[selections++];assert.ok(candidate);assert.equal(opts.excludeUpstream.size+opts.excludeSiwc.size,selections-1);
  const table=candidate.kind==='siwc'?'siwc_account_attempts':'ordinary_account_attempts';
  const script=`const D=require('better-sqlite3');const db=new D(process.argv[1]);db.prepare('INSERT INTO ${table}(account_id,attempt_id) VALUES (?,?)').run(process.argv[2],'other');db.close()`;
  const child=spawnSync(process.execPath,['-e',script,file,candidate.id],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);
  return candidate;
 };
 try {const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});await handling;assert.equal(r.status,503,r.text);assert.equal(selections,16);assert.equal(providerCalls,0);}
 finally {globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});};accountPool.selectCandidate=originalSelect;for(const c of candidates) if(c.kind==='upstream')repo.update(c.id,{status:'disabled'});}
});
test('explicit private SIWC pin never falls back to an available ordinary account', {timeout:10000},async()=>{
 accountPool.selectCandidate=originalSelect;
 const c=repo.create({name:'eligible',provider:'openai',credentialType:'api_key',credentials:'sk-eligible',dailyQuota:1});
 const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
 const {CredentialVault}=await import('../src/utils/encryption.ts');
 db.exec("CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('private','private')");
 new SiwcStore(db,new CredentialVault()).create('private',{issuer:'https://auth.openai.com',subject:'fixture',clientId:'fixture',accessToken:'fixture',idToken:'fixture',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
 db.prepare("INSERT INTO siwc_access_policy(account_id,enabled,scope) VALUES ('private',1,'selected')").run();
 const before=calls.length;
 const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{siwc_account_id:'private'}});await handling;
 assert.equal(r.status,404,r.text);assert.equal(calls.length,before);
 assert.equal(db.prepare('SELECT count(*) AS n FROM account_daily_reservations WHERE account_id=?').get(c.id).n,0);
 repo.update(c.id,{status:'disabled'});
});
test('ordinary exclusion does not exclude an authorized SIWC with the same id', {timeout:30000},async()=>{
 const d=repo.create({name:'collision',provider:'openai',credentialType:'api_key',credentials:'sk-collision',priority:0,dailyQuota:1});
 const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
 const {CredentialVault}=await import('../src/utils/encryption.ts');
 db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run(d.id,'collision');
 new SiwcStore(db,new CredentialVault()).create(d.id,{issuer:'https://auth.openai.com',subject:'fixture2',clientId:'fixture2',accessToken:'siwc-token',idToken:'fixture',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
 db.prepare("INSERT INTO siwc_access_policy VALUES (?,1,'all')").run(d.id);
 db.prepare('INSERT INTO siwc_routing_settings VALUES (?,10,1)').run(d.id);
 let blocked=false;
 accountPool.selectCandidate=async (...args)=>{const selected=await originalSelect(...args);if(!blocked){blocked=true;assert.equal(selected.kind,'upstream');assert.equal(selected.id,d.id);const child=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker,file,d.id],{env:process.env,encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);}return selected;};
 const before=calls.length;globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 const r=await request({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}});await handling;
 assert.equal(r.status,200,r.text);assert.deepEqual(calls.slice(before),['Bearer siwc-token']);
 assert.equal(db.prepare('SELECT used FROM account_daily_reservations WHERE account_id=?').get(d.id).used,1);
});
