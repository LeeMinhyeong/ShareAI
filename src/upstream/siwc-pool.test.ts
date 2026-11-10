import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { responseStream, chatStream } from './siwc-pool-fixtures.js';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);
await (await import(new URL('../../tests/helpers/fresh-db.mjs', import.meta.url).href)).useFreshFileDatabase(); // test-only helper outside rootDir // the production client refuses an unprovisioned :memory: database
const { getDb } = await import('../db/client.js');
const { CredentialVault } = await import('../utils/encryption.js');
const { SiwcStore } = await import('./siwc-store.js');
const { forwardChat } = await import('./forward-chat.js');

test('normal chat selects authorized SIWC and records usage', async () => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('pool-user','pool-hash','test','pool@example.invalid','free'); INSERT INTO siwc_accounts VALUES ('pool-siwc','test'); INSERT INTO siwc_access_policy VALUES ('pool-siwc',1,'all')");
  new SiwcStore(db, new CredentialVault()).create('pool-siwc', {issuer:'https://auth.openai.com',subject:'synthetic',clientId:'pool-issued',accessToken:'synthetic-access',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (input: any, init: any) => { assert.equal(input,'https://api.openai.com/v1/responses'); assert.equal(init.headers.authorization,'Bearer synthetic-access'); calls++; return new Response(responseStream.replace('"status":"completed","output"','"status":"completed","usage":{"input_tokens":3,"output_tokens":2},"output"'),{headers:{'content-type':'text/event-stream'}}); }) as typeof fetch;
  const app = express(); app.use(express.json()); app.post('/chat',(req,_res,next)=>{req.user={id:'pool-user'} as any; next();},forwardChat);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const response = await original(`http://127.0.0.1:${(server.address() as any).port}/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}]})});
    assert.equal(response.status,200); assert.equal(((await response.json()) as any).choices[0].message.content,'hello'); assert.equal(calls,1);
    assert.deepEqual(db.prepare('SELECT account_id,user_id,success,input_tokens,output_tokens FROM siwc_usage_logs').get(),{account_id:'pool-siwc',user_id:'pool-user',success:1,input_tokens:3,output_tokens:2});
    const { UsageLogRepository } = await import('../db/repositories/usage-logs.js');
    const repo = new UsageLogRepository();
    assert.deepEqual(repo.getTodayStats('pool-user'),{totalRequests:1,successRequests:1,totalTokens:5,totalTokensComplete:true});
    const log = repo.findByUser('pool-user')[0] as any;
    assert.equal(log.accountKind,'siwc'); assert.equal(log.accountId,'pool-siwc');
    assert.throws(() => db.prepare("DELETE FROM siwc_accounts WHERE id='pool-siwc'").run());
    assert.throws(() => db.prepare("DELETE FROM users WHERE id='pool-user'").run());
  } finally {globalThis.fetch=original; server.close();}
});

test('mixed candidates respect ACL, priority, least used and weighted rotation', async () => {
  const db = getDb();
  const { AccountRepository } = await import('../db/repositories/accounts.js');
  const { AccountPoolManager } = await import('../account-pool/manager.js');
  const upstream = new AccountRepository().create({name:'mixed',provider:'openai',credentialType:'api_key',credentials:'sk-synthetic',priority:1,weight:2});
  const pool = new AccountPoolManager();
  const select = (strategy: 'priority'|'least_used'|'round_robin', user='pool-user') => pool.selectCandidate(user,'gpt-5','openai',strategy,{credentialTypes:['api_key','oauth']});
  assert.equal((await select('priority'))?.kind,'siwc');
  assert.equal((await select('least_used'))?.kind,'upstream');
  const picks = []; for (let i=0;i<6;i++) picks.push((await select('round_robin'))?.kind);
  assert.equal(picks.filter(x=>x==='upstream').length,4); assert.equal(picks.filter(x=>x==='siwc').length,2);
  db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('other','other-hash','other','other@example.invalid','free')").run();
  db.prepare("UPDATE siwc_access_policy SET scope='selected' WHERE account_id='pool-siwc'").run();
  db.prepare("INSERT INTO siwc_access_users VALUES ('pool-siwc','pool-user')").run();
  assert.equal((await select('priority','other'))?.kind,'upstream');
  assert.equal((await select('priority'))?.kind,'siwc');
  db.prepare("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='pool-siwc'").run();
  assert.equal((await select('priority'))?.kind,'upstream');
  db.prepare("UPDATE siwc_access_policy SET enabled=1,scope='all' WHERE account_id='pool-siwc'").run();
  db.prepare('DELETE FROM upstream_accounts WHERE id=?').run(upstream.id);
});

test('no-usage success and 429 failure are logged without failover', async () => {
  const db=getDb(); const original=globalThis.fetch; let calls=0;
  const {AccountRepository} = await import('../db/repositories/accounts.js');
  const alternative = new AccountRepository().create({name:'alternative',provider:'openai',credentialType:'api_key',credentials:'sk-synthetic',priority:1});
  globalThis.fetch=(async (input: any, init: any) => {
    calls++;
    if (calls <= 2) {
      assert.equal(input,'https://api.openai.com/v1/responses');
      assert.equal(init.headers.authorization,'Bearer synthetic-access');
      return calls===1 ? new Response(responseStream,{headers:{'content-type':'text/event-stream'}}) : new Response('',{status:429});
    }
    assert.equal(input,'https://api.openai.com/v1/chat/completions');
    assert.equal(init.headers.authorization,'Bearer sk-synthetic');
    return new Response(chatStream,{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const app=express(); app.use(express.json()); app.post('/chat',(req,_res,next)=>{req.user={id:'pool-user'} as any; next();},forwardChat);
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url=`http://127.0.0.1:${(server.address() as any).port}/chat`;
    const send=()=>original(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy:'priority'}})});
    assert.equal((await send()).status,200); assert.equal((await send()).status,429); assert.equal(calls,2);
    const rows=db.prepare('SELECT success,status,input_tokens,output_tokens,aborted FROM siwc_usage_logs ORDER BY rowid DESC LIMIT 2').all();
    assert.deepEqual(rows,[{success:0,status:429,input_tokens:null,output_tokens:null,aborted:0},{success:1,status:200,input_tokens:null,output_tokens:null,aborted:0}]);
    // The failing request is not retried, but the next request rotates away from the cooled SIWC.
    assert.equal((await send()).status,200); assert.equal(calls,3);
  } finally {globalThis.fetch=original; server.close(); db.prepare('DELETE FROM usage_logs WHERE upstream_account_id=?').run(alternative.id); db.prepare('DELETE FROM upstream_accounts WHERE id=?').run(alternative.id);}
});

test('client abort records a failed aborted SIWC request', async () => {
  const db=getDb(), original=globalThis.fetch;
  db.prepare("DELETE FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='pool-siwc'").run(); // ADR 0008: the cooldown is the v2 restriction
  // A fresh credential revision avoids inheriting the preceding test's cooldown.
  const store = new SiwcStore(db, new CredentialVault(), { initialize: false });
  const credential = store.read('pool-siwc');
  assert.ok(credential);
  store.replace('pool-siwc', credential);
  let dispatched!: () => void; const dispatchedPromise=new Promise<void>(r=>{dispatched=r;});
  globalThis.fetch=((_input: any, init: any) => new Promise((_resolve,reject) => {
    dispatched(); init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  })) as typeof fetch;
  const app=express(); app.use(express.json()); app.post('/chat',(req,_res,next)=>{req.user={id:'pool-user'} as any; next();},forwardChat);
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const controller=new AbortController();
  let dispatchTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending=original(`http://127.0.0.1:${(server.address() as any).port}/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}]}),signal:controller.signal}).catch(()=>null);
    await Promise.race([
      dispatchedPromise,
      pending.then(() => { throw new Error('request ended before SIWC dispatch'); }),
      new Promise<never>((_,reject) => { dispatchTimeout=setTimeout(() => reject(new Error('SIWC dispatch timed out')),2000); }),
    ]);
    controller.abort(); await pending;
    for (let i=0;i<100 && !(db.prepare('SELECT 1 FROM siwc_usage_logs WHERE aborted=1').get());i++) await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(db.prepare('SELECT success,aborted,input_tokens,output_tokens FROM siwc_usage_logs WHERE aborted=1').get(),{success:0,aborted:1,input_tokens:null,output_tokens:null});
  } finally {if (dispatchTimeout) clearTimeout(dispatchTimeout); controller.abort(); globalThis.fetch=original; server.close();}
});
