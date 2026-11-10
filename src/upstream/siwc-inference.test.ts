import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);
await (await import(new URL('../../tests/helpers/fresh-db.mjs', import.meta.url).href)).useFreshFileDatabase(); // test-only helper outside rootDir // the production client refuses an unprovisioned :memory: database
const { getDb } = await import('../db/client.js');
const { CredentialVault } = await import('../utils/encryption.js');
const { SiwcStore } = await import('./siwc-store.js');
const { forwardChat } = await import('./forward-chat.js');
const { infer, UpstreamError } = await import('./inference.js');
const event = (e: any) => `data: ${JSON.stringify(e)}\n\n`;
const part = (text: string) => ({type:'output_text',text,annotations:[]});
const item = (status: string, content: any[]) => ({id:'msg_1',type:'message',status,role:'assistant',content});
const responsePrefix = (text: string) => [
  {type:'response.created',response:{id:'resp_1',status:'in_progress'}},
  {type:'response.in_progress',response:{id:'resp_1',status:'in_progress'}},
  {type:'response.output_item.added',output_index:0,item:item('in_progress',[])},
  {type:'response.content_part.added',item_id:'msg_1',output_index:0,content_index:0,part:part('')},
  {type:'response.output_text.delta',item_id:'msg_1',output_index:0,content_index:0,delta:text},
].map(event).join('');
const responseSuccess = (text: string) => responsePrefix(text) + [
  {type:'response.output_text.done',item_id:'msg_1',output_index:0,content_index:0,text},
  {type:'response.content_part.done',item_id:'msg_1',output_index:0,content_index:0,part:part(text)},
  {type:'response.output_item.done',output_index:0,item:item('completed',[part(text)])},
  {type:'response.completed',response:{id:'resp_1',status:'completed',output:[item('completed',[part(text)])]}},
].map(event).join('');

test('selected SIWC account uses Responses endpoint for chat inference', async () => {
  const db = getDb(); const store = new SiwcStore(db, new CredentialVault());
  db.exec('CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('u','hash','test','u@example.invalid','free')").run();
  db.prepare('INSERT INTO siwc_accounts VALUES (?, ?)').run('siwc-1', 'test');
  db.prepare("INSERT INTO siwc_access_policy VALUES ('siwc-1',1,'all')").run();
  store.create('siwc-1', {issuer:'https://auth.openai.com',subject:'synthetic',clientId:'issued',accessToken:'synthetic-access',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    assert.equal(input, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer synthetic-access');
    assert.equal(init.headers['chatgpt-account-id'], undefined);
    const body = JSON.parse(init.body); assert.equal(body.store, false); assert.equal(body.stream, true);
    requests++;
    return new Response(responseSuccess('hello'), {headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const app = express(); app.use(express.json()); app.post('/chat', (req,_res,next) => {req.user = {id:'u'} as any; next();}, forwardChat);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const result = await original(`http://127.0.0.1:${(server.address() as any).port}/chat`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{siwc_account_id:'siwc-1'}})});
    assert.equal(result.status,200); assert.equal(((await result.json()) as any).choices[0].message.content,'hello'); assert.equal(requests,1);
  } finally {globalThis.fetch = original; server.close();}
});

test('SIWC selection rejects missing permission and expired credentials without fallback', async () => {
  const db = getDb(); const store = new SiwcStore(db, new CredentialVault());
  const credential = {issuer:'https://auth.openai.com',subject:'synthetic',clientId:'issued2',accessToken:'synthetic',idToken:'synthetic',tokenType:'Bearer',expiresIn:1,scopes:['openid'],savedAt:new Date().toISOString()};
  db.prepare('INSERT INTO siwc_accounts VALUES (?, ?)').run('no-scope', 'no scope'); store.create('no-scope', credential);
  db.prepare('INSERT INTO siwc_accounts VALUES (?, ?)').run('expired', 'expired'); store.create('expired', {...credential,clientId:'issued3',scopes:['chatgpt.tokens.use.direct'],savedAt:'2020-01-01T00:00:00.000Z'});
  db.exec("INSERT INTO siwc_access_policy VALUES ('no-scope',1,'all'),('expired',1,'all')");
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => {calls++; throw new Error('unexpected network');}) as typeof fetch;
  const app = express(); app.use(express.json()); app.post('/chat', (req,_res,next) => {req.user = {id:'u'} as any; next();}, forwardChat);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    for (const [id,status] of [['no-scope',403],['expired',503],['missing',404]] as const) {
      const response = await original(`http://127.0.0.1:${(server.address() as any).port}/chat`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:id}})});
      assert.equal(response.status,status);
    }
    assert.equal(calls,0);
  } finally {globalThis.fetch = original; server.close();}
});

test('SIWC maps system instructions out of Responses input', async () => {
  const original = globalThis.fetch;
  let sent: any;
  globalThis.fetch = (async (_input: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(responseSuccess('hello'), {headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  try {
    const events = await infer('openai', {kind:'siwc', token:'synthetic'}, {model:'gpt-5', messages:[{role:'system',content:'System rule'}, {role:'developer',content:'Developer rule'}, {role:'user',content:'hi'}]});
    for await (const _event of events) {}
    assert.equal(sent.instructions, 'System rule');
    assert.deepEqual(sent.input, [{role:'developer',content:'Developer rule'}, {role:'user',content:'hi'}]);
  } finally { globalThis.fetch = original; }
});

test('SIWC terminal usage-limit event is a 429, not success', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('data: {"type":"response.failed","sequence_number":0,"response":{"id":"resp_1","status":"failed","error":{"code":"subscription_sharing_usage_limit_exceeded","message":"usage limit"}}}\n\n', {headers:{'content-type':'text/event-stream'}})) as typeof fetch;
  try {
    const events = await infer('openai', {kind:'siwc',token:'synthetic'}, {model:'gpt-5',messages:[{role:'user',content:'hi'}]});
    await assert.rejects(async () => { for await (const _event of events) {} }, (e: any) => e instanceof UpstreamError && e.status === 429 && e.message.includes('subscription_sharing_usage_limit_exceeded'));
  } finally { globalThis.fetch = original; }
});

test('SIWC streaming failure is delivered as an error, never DONE', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(responsePrefix('partial') + event({type:'response.failed',sequence_number:5,response:{id:'resp_1',status:'failed',error:{code:'subscription_sharing_usage_limit_exceeded',message:'usage limit'}}}), {headers:{'content-type':'text/event-stream'}})) as typeof fetch;
  const app = express(); app.use(express.json()); app.post('/chat', (req,_res,next) => {req.user = {id:'u'} as any; next();}, forwardChat);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const response = await original(`http://127.0.0.1:${(server.address() as any).port}/chat`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],stream:true,router_options:{siwc_account_id:'siwc-1'}})});
    const text = await response.text(); assert.match(text,/partial/); assert.match(text,/subscription_sharing_usage_limit_exceeded/); assert.doesNotMatch(text,/\[DONE\]/);
  } finally {globalThis.fetch = original; server.close();}
});
