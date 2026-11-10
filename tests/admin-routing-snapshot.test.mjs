import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import express from 'express';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'routing-snapshot-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {default:v1}=await import('../src/routes/v1.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {default:admin}=await import('../src/routes/admin.ts');
const {arm429V2}=await import('../src/db/account-429-v2-store.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(), repo=new AccountRepository();
const app=express();app.use(express.json());app.use('/admin',admin);app.use('/v1',v1);
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}/admin/routing-snapshot`;

test('admin routing snapshot reports effective OPEN, v2 restriction and local cooldown without secrets',async()=>{
 try {
  const ordinary=repo.create({name:'fixture',provider:'openai',credentialType:'api_key',credentials:'secret-ordinary'});
  const cool=repo.create({name:'fixture2',provider:'openai',credentialType:'api_key',credentials:'secret-ordinary2'});
  const broken=repo.create({name:'broken',provider:'openai',credentialType:'api_key',credentials:'secret-broken'});
  db.prepare('UPDATE upstream_accounts SET credentials=? WHERE id=?').run('bad-ciphertext',broken.id);
  const expired=repo.create({name:'expired',provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'secret-expired',accountId:'synthetic-workspace',expiresAt:Date.now()-1000})});
  const local=repo.create({name:'local',provider:'openai',credentialType:'api_key',credentials:'secret-local'});
  const invalidQuota=repo.create({name:'invalid-quota',provider:'openai',credentialType:'api_key',credentials:'secret-quota'});
  const invalidTime=repo.create({name:'invalid-time',provider:'openai',credentialType:'api_key',credentials:'secret-time'});
  db.prepare('UPDATE upstream_accounts SET daily_quota=-1 WHERE id=?').run(invalidQuota.id);
  // A legacy cooldown row (even a malformed one) is not consulted: selection and the snapshot read v2 only (ADR 0008).
  db.prepare('INSERT INTO account_429_cooldowns VALUES(?,?,?,?,?)').run('upstream',invalidTime.id,Date.now(),8640000000000001,1);
  const {accountPool}=await import('../src/account-pool/manager.ts');
  accountPool.recordFailure(local.id,{status:500,message:'synthetic'});
  db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('si-open','fixture'),('si-cool','fixture'),('si-expired','fixture'),('si-ready','fixture');");
  const store=new SiwcStore(db,new CredentialVault());
  for(const id of ['si-open','si-cool','si-expired','si-ready']) {
   store.create(id,{issuer:'https://auth.openai.com',subject:'secret-subject',clientId:id,accessToken:'secret-access',idToken:'secret-id-token',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date(Date.now()-(id==='si-expired'?7200000:0)).toISOString()});
   db.prepare("INSERT INTO siwc_access_policy(account_id,enabled,scope) VALUES(?,1,'all')").run(id);
  }
  db.prepare('INSERT INTO ordinary_account_attempts VALUES(?,?)').run(ordinary.id,'secret-attempt');
  db.prepare('INSERT INTO siwc_account_attempts VALUES(?,?)').run('si-open','secret-attempt');
  // A shared 429 restriction is a v2 row (relative, monotonic expiry); the snapshot reports it as 'restricted'.
  for(const [kind,id] of [['upstream',cool.id],['siwc','si-cool']]) db.transaction(()=>arm429V2(db,kind,id,60000)).immediate();
  const siRevision=store.readSnapshot('si-ready').revision;
  accountPool.recordSiwcFailure('si-ready',siRevision);
  for(const [auth,status] of [[undefined,401],['Bearer invalid-user-key',403]]) {const r=await fetch(url,{headers:auth?{authorization:auth}:{}});assert.equal(r.status,status);assert.match(r.headers.get('cache-control'),/no-store/);assert.ok(!(await r.text()).includes('si-open'));}
  const totalBefore=db.prepare('SELECT total_changes() AS n').get().n;
  const markerBefore=accountPool.siwcFailureMarker('si-ready');
  const localBefore=accountPool.observedCooldown(local.id,local.stateRevision);
  const res=await fetch(url,{headers:{authorization:`Bearer ${process.env.ADMIN_API_KEY}`}}); assert.equal(res.status,200);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n,totalBefore);
  assert.equal(accountPool.siwcFailureMarker('si-ready'),markerBefore);
  assert.equal(accountPool.observedCooldown(local.id,local.stateRevision),localBefore);
  assert.match(res.headers.get('cache-control'),/no-store/);
  const text=await res.text(); assert.doesNotMatch(text,/secret-|attempt_id|email|prompt/);
  const body=JSON.parse(text);assert.match(body.as_of,/Z$/);assert.match(body.note,/ACL.*model.*quota.*process-local/i);
  const row=(kind,id)=>body.accounts.find(x=>x.kind===kind&&x.id===id);
  for(const [kind,id] of [['upstream',ordinary.id],['siwc','si-open']]) assert.equal(row(kind,id).state,'open');
  for(const [kind,id] of [['upstream',cool.id],['siwc','si-cool']]) {assert.equal(row(kind,id).state,'restricted');assert.equal(row(kind,id).cooldown_until,undefined);}
  assert.equal(row('siwc','si-expired').state,'unavailable');assert.equal(row('siwc','si-ready').state,'cooldown_until');
  accountPool.recordSiwcSuccess('si-ready',siRevision,accountPool.siwcFailureMarker('si-ready'));
  // Expiry removes the v2 rows (as the monotonic expiry service would).
  db.prepare('DELETE FROM account_429_v2_restrictions WHERE account_id IN (?,?)').run(cool.id,'si-cool');
  const after=await (await fetch(url,{headers:{authorization:`Bearer ${process.env.ADMIN_API_KEY}`}})).json();
  for(const [kind,id] of [['upstream',cool.id],['siwc','si-cool'],['siwc','si-ready']]) assert.equal(after.accounts.find(a=>a.kind===kind&&a.id===id).state,'no_known_block');
  assert.equal(row('upstream',broken.id).state,'unavailable');assert.equal(row('upstream',expired.id).state,'unavailable');
  assert.equal(row('upstream',local.id).state,'cooldown_until');
  assert.equal(row('upstream',invalidQuota.id).state,'unknown');
  assert.equal(row('upstream',invalidTime.id).state,'no_known_block');
  db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('user',hashApiKey('synthetic-user-key'),'user','fixture@example.invalid','pro',100);
  db.prepare("UPDATE siwc_access_policy SET scope='selected' WHERE account_id='si-open'").run();
  const chat=async id => {const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer synthetic-user-key','content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:id}})});return [r.status,await r.text()];};
  assert.deepEqual(await chat('si-open'),await chat('nonexistent'));
  const denied=await fetch(url,{headers:{authorization:'Bearer synthetic-user-key'}});assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes('si-open'));
 } finally {await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});}
});
