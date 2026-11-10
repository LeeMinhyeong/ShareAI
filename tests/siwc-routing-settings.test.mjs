import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch', 'siwc-routing-'));
process.chdir(dir);
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${join(dir,'fixture.db')}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'synthetic-admin-key-for-testing'});
const {getDb, closeDatabase} = await import('../src/db/client.ts');
const {default: admin} = await import('../src/routes/admin.ts');
const {CredentialVault} = await import('../src/utils/encryption.ts');
const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {AccountPoolManager} = await import('../src/account-pool/manager.ts');

await test('admin routing settings persist and govern mixed selection without exposing credentials', async () => {
  await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // production client never creates a database
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO siwc_accounts VALUES ('synthetic-siwc','test');
    INSERT INTO users(id,api_key_hash,name,email,tier) VALUES ('routing-user','hash','user','test@example.invalid','free');
    INSERT INTO siwc_access_policy VALUES ('synthetic-siwc',1,'all');`);
  new SiwcStore(db,new CredentialVault()).create('synthetic-siwc',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'synthetic-client',accessToken:'synthetic-secret',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const before = db.prepare('SELECT * FROM siwc_credentials').get();
  const app=express(); app.use(express.json()); app.use('/admin',admin);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}/admin/accounts/siwc/accounts/synthetic-siwc/routing`;
  const headers={authorization:`Bearer ${process.env.ADMIN_API_KEY}`,'content-type':'application/json'};
  const get=()=>fetch(url,{headers});
  const post=body=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"priority":0,"weight":1}'})).status,401);
    assert.equal((await fetch(url.replace('synthetic-siwc','missing'),{headers})).status,404);
    let r=await get(); assert.equal(r.status,200); assert.match(r.headers.get('cache-control'),/no-store/); assert.deepEqual(await r.json(),{priority:0,weight:1});
    for (const bad of [{priority:-1,weight:1},{priority:1001,weight:1},{priority:0,weight:0},{priority:0,weight:101},{priority:0.5,weight:1},{priority:'1',weight:1},{priority:0,weight:1,extra:1}]) assert.equal((await post(bad)).status,400);
    r=await post({priority:4,weight:3}); assert.equal(r.status,200); assert.deepEqual(await r.json(),{priority:4,weight:3});
    assert.deepEqual(await (await get()).json(),{priority:4,weight:3});
    assert.deepEqual(db.prepare('SELECT * FROM siwc_credentials').get(),before);
    const upstream=new AccountRepository().create({name:'upstream',provider:'openai',credentialType:'api_key',credentials:'sk-synthetic',priority:2,weight:1});
    const pool=new AccountPoolManager();
    const choose=strategy=>pool.selectCandidate('routing-user','gpt-5','openai',strategy);
    assert.equal((await choose('priority')).id,upstream.id);
    const picks=[]; for(let i=0;i<8;i++) picks.push((await choose('round_robin')).kind);
    assert.equal(picks.filter(x=>x==='siwc').length,6);
    assert.equal(picks.filter(x=>x==='upstream').length,2);
    assert.equal((await post({priority:1,weight:1})).status,200);
    assert.equal((await choose('priority')).id,'synthetic-siwc');
    db.exec("INSERT INTO siwc_accounts VALUES ('another-siwc','test 2'); INSERT INTO siwc_access_policy VALUES ('another-siwc',1,'all'); INSERT INTO siwc_routing_settings VALUES ('another-siwc',1,1);");
    new SiwcStore(db,new CredentialVault()).create('another-siwc',{issuer:'https://auth.openai.com',subject:'synthetic-2',clientId:'synthetic-client-2',accessToken:'synthetic-secret-2',idToken:'synthetic-id-2',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
    assert.equal((await choose('priority')).id,'another-siwc');
    db.prepare("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='another-siwc'").run();
    assert.equal((await post({priority:4,weight:3})).status,200);
    db.prepare("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='synthetic-siwc'").run();
    assert.equal((await choose('priority')).id,upstream.id);
    db.prepare("UPDATE siwc_access_policy SET enabled=1,scope='selected' WHERE account_id='synthetic-siwc'").run();
    assert.equal((await choose('round_robin')).id,upstream.id);
  } finally {await new Promise(resolve=>server.close(resolve)); closeDatabase();}
  const reopened=new Database(join(dir,'fixture.db'),{readonly:true});
  try {
    assert.deepEqual(reopened.prepare('SELECT priority,weight FROM siwc_routing_settings WHERE account_id=?').get('synthetic-siwc'),{priority:4,weight:3});
    assert.deepEqual(reopened.prepare('SELECT * FROM siwc_credentials').get(),before);
    assert.deepEqual(reopened.pragma('foreign_key_check'),[]);
  } finally {reopened.close();}
});
