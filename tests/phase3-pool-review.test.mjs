import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chatStream, responseStream} from './phase4-protocol-fixtures.mjs';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
process.chdir(mkdtempSync(path.join(process.env.TMPDIR,'pool-review-')));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {getDb}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {SettingsRepository}=await import('../src/db/repositories/settings.ts');
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const db=getDb(), vault=new CredentialVault(), store=new SiwcStore(db,vault);
db.exec("CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('u','h','u','u@example.invalid','free'); INSERT INTO siwc_accounts VALUES ('s','s'); INSERT INTO siwc_access_policy VALUES ('s',1,'all')");
const base={issuer:'https://auth.openai.com',subject:'synthetic',clientId:'fixture',accessToken:'token',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()};
store.create('s',base);
const api=new AccountRepository().create({name:'api',provider:'openai',credentialType:'api_key',credentials:'sk-test',priority:1});
async function send(body={}) {
 const res=new EventEmitter(); Object.assign(res,{statusCode:200,headersSent:false,writableEnded:false,status(n){this.statusCode=n;return this},json(value){this.value=value;this.writableEnded=true;return this},getHeader(){},setHeader(){},end(){this.writableEnded=true},destroy(){}});
 await forwardChat({user:{id:'u'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],...body}},res);
 if(res.statusCode===200) {assert.equal(res.writableEnded,true);assert.equal(res.value?.object,'chat.completion');assert.equal(res.value.choices[0].message.content,'hello');assert.equal(res.value.choices[0].finish_reason,'stop');}
 return res;
}
const original=globalThis.fetch; let urls=[];
globalThis.fetch=async (url)=>{urls.push(url); return new Response(String(url).includes('/chat/completions') ? chatStream : responseStream,{headers:{'content-type':'text/event-stream'}})};
test('request options select compatible API key before dispatch',async()=>{urls=[]; const r=await send({temperature:0.5,router_options:{strategy:'priority'}}); assert.equal(r.statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/chat/completions']);});
test('invalid automatic SIWC credential does not block usable API account',async()=>{store.replace('s',{...base,scopes:[]}); try { urls=[]; const r=await send({router_options:{strategy:'priority'}}); assert.equal(r.statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/chat/completions']); } finally { store.replace('s',base); }});
test('administrator strategy applies when not explicitly overridden',async()=>{new SettingsRepository().setStrategy('openai','priority'); urls=[]; const r=await send(); assert.equal(r.statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/responses']);});
test('corrupt and expired unrefreshable SIWC credentials are excluded',async()=>{
 const row=db.prepare('SELECT credentials FROM siwc_credentials WHERE id=?').get('s');
 try {
  for (const credentials of ['corrupt',vault.encrypt(JSON.stringify({...base,savedAt:'2000-01-01T00:00:00.000Z'})),vault.encrypt(JSON.stringify({...base,invalidated:true}))]) {
   db.prepare('UPDATE siwc_credentials SET credentials=? WHERE id=?').run(credentials,'s'); urls=[];
   const r=await send({router_options:{strategy:'priority'}}); assert.equal(r.statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/chat/completions']);
  }
 } finally {db.prepare('UPDATE siwc_credentials SET credentials=? WHERE id=?').run(row.credentials,'s');}
});
test('expired SIWC with already claimed refresh token is excluded before dispatch',async()=>{
 const {createHash}=await import('node:crypto'); const token='claimed-refresh';
 const row=db.prepare('SELECT credentials FROM siwc_credentials WHERE id=?').get('s');
 const fingerprint=createHash('sha256').update(JSON.stringify(['openai',token])).digest('hex');
 try {db.prepare('UPDATE siwc_credentials SET credentials=? WHERE id=?').run(vault.encrypt(JSON.stringify({...base,savedAt:'2000-01-01T00:00:00.000Z',refreshToken:token,scopes:['chatgpt.tokens.use.direct','offline_access']})),'s'); db.prepare('INSERT INTO oauth_refresh_intents VALUES (?,?,?,?)').run(fingerprint,'claimed','s',new Date().toISOString()); urls=[]; const r=await send({router_options:{strategy:'priority'}}); assert.equal(r.statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/chat/completions']);} finally {db.prepare('UPDATE siwc_credentials SET credentials=? WHERE id=?').run(row.credentials,'s'); db.prepare('DELETE FROM oauth_refresh_intents WHERE token_fingerprint=?').run(fingerprint);}
});
test('explicit unauthorized SIWC never falls back',async()=>{
 db.prepare("UPDATE siwc_access_policy SET scope='selected' WHERE account_id='s'").run();
 try {urls=[]; const r=await send({router_options:{siwc_account_id:'s'}}); assert.equal(r.statusCode,404); assert.deepEqual(urls,[]);} finally {db.prepare("UPDATE siwc_access_policy SET scope='all' WHERE account_id='s'").run();}
});
test('provider 429 does not trigger same-request fallback',async()=>{
 const previous=globalThis.fetch; urls=[]; globalThis.fetch=async url=>{urls.push(url);return new Response('',{status:429})};
 try {const r=await send({router_options:{strategy:'priority'}}); assert.equal(r.statusCode,429); assert.deepEqual(urls,['https://api.openai.com/v1/responses']);} finally {globalThis.fetch=previous; db.prepare("DELETE FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id=?").run('s'); store.replace('s',base);}
});
test('round robin can select another account on request after SIWC 429',async()=>{
 const {accountPool}=await import('../src/account-pool/manager.ts'); accountPool.roundRobinCounters.clear();
 const previous=globalThis.fetch; urls=[]; globalThis.fetch=async url=>{urls.push(url); return urls.length===1 ? new Response('',{status:429}) : new Response(chatStream,{headers:{'content-type':'text/event-stream'}})};
 try {assert.equal((await send({router_options:{strategy:'round_robin'}})).statusCode,429); assert.equal((await send({router_options:{strategy:'round_robin'}})).statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/responses','https://api.openai.com/v1/chat/completions']);} finally {globalThis.fetch=previous;}
});
test('max_tokens excludes Codex OAuth and SIWC before choosing API key',async()=>{
 const oauth=new AccountRepository().create({name:'codex',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({access_token:'fixture',account_id:'fixture'}),priority:-1});
 try {urls=[]; const r=await send({max_tokens:100,router_options:{strategy:'priority'}}); assert.equal(r.statusCode,200); assert.deepEqual(urls,['https://api.openai.com/v1/chat/completions']);} finally {db.prepare('DELETE FROM upstream_accounts WHERE id=?').run(oauth.id);}
});
test('user quota reservations differ from usage statistics',async()=>{
 const {UserRepository}=await import('../src/db/repositories/users.ts'); const {UsageLogRepository}=await import('../src/db/repositories/usage-logs.ts');
 const users=new UserRepository(), stats=new UsageLogRepository(); const before=stats.getTodayStats('u'); const prior=users.getTodayUsageCount('u');
 assert.equal(users.reserveDailyQuota('h').allowed,true); assert.equal(users.getTodayUsageCount('u'),prior+1); assert.deepEqual(stats.getTodayStats('u'),before);
});
process.on('exit',()=>{globalThis.fetch=original});
