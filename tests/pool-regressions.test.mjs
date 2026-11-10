import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(mkdtempSync(path.join(process.env.TMPDIR,'pool-isolated-')));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {getDb}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const db=getDb();
db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('a','ha','a','a@example.invalid','free'),('b','hb','b','b@example.invalid','free'); INSERT INTO siwc_accounts VALUES ('s','s'); INSERT INTO siwc_access_policy VALUES ('s',1,'selected'); INSERT INTO siwc_access_users VALUES ('s','a')");
new SiwcStore(db,new CredentialVault()).create('s',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'fixture',accessToken:'token',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
const api=new AccountRepository().create({name:'api',provider:'openai',credentialType:'api_key',credentials:'sk-test',weight:1});
const select=(pool,user,opts={})=>pool.selectCandidate(user,'gpt-5','openai','round_robin',opts);
test('interleaved ACL candidate sets do not starve either account',async()=>{
 const pool=new AccountPoolManager(), seen=[];
 for(let i=0;i<6;i++){seen.push((await select(pool,'a')).kind); assert.equal((await select(pool,'b')).kind,'upstream');}
 assert.deepEqual(seen.filter(x=>x==='siwc').length,3);
 db.prepare("DELETE FROM siwc_access_users WHERE account_id='s' AND user_id='a'").run();
 assert.equal((await select(pool,'a')).kind,'upstream');
 db.prepare("INSERT INTO siwc_access_users VALUES ('s','a')").run();
 const again=[]; for(let i=0;i<4;i++) again.push((await select(pool,'a')).kind);
 assert.equal(again.filter(x=>x==='siwc').length,2);
});
test('credential type restrictions treat SIWC as oauth',async()=>{
 const pool=new AccountPoolManager();
 assert.equal((await pool.selectCandidate('a','gpt-5','openai','priority',{credentialTypes:['api_key']})).kind,'upstream');
 assert.equal((await pool.selectCandidate('a','gpt-5','openai','priority',{credentialTypes:['oauth']})).kind,'siwc');
 assert.equal(await pool.selectCandidate('a','gpt-5','openai','priority',{credentialTypes:[]}),null);
});
test('every supported SIWC weight is honored against an upstream account',async()=>{
 try {
  for(let weight=1;weight<=100;weight++) {
   db.prepare('INSERT INTO siwc_routing_settings(account_id,priority,weight) VALUES (?,0,?) ON CONFLICT(account_id) DO UPDATE SET weight=excluded.weight').run('s',weight);
   const pool=new AccountPoolManager(); let siwc=0, upstream=0;
   for(let i=0;i<weight+1;i++) {
    const candidate=await select(pool,'a');
    if(candidate.kind==='siwc') siwc++; else upstream++;
   }
   assert.equal(siwc,weight,`weight ${weight}`); assert.equal(upstream,1,`weight ${weight}`);
  }
 } finally {db.prepare("DELETE FROM siwc_routing_settings WHERE account_id='s'").run();}
});
test('rotation state remains bounded for changing eligible sets',()=>{
 const pool=new AccountPoolManager();
 for(let i=0;i<1500;i++) pool.roundRobinOrder('openai',[{id:String(i),weight:1}],x=>x.id);
 assert.ok(pool.roundRobinCounters.size<=1024);
});
test('huge and malformed legacy weights run with bounded memory and preserve the database',()=>{
 const worker=new URL('./pool-weight-worker.mjs',import.meta.url);
 const child=spawnSync(process.execPath,['--max-old-space-size=64','--import','tsx',fileURLToPath(worker)],{cwd:new URL('..',import.meta.url),env:process.env,encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr || child.error?.message);
});
