import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';

process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);

const { accountPool } = await import('../account-pool/manager.js');
const { forwardChat } = await import('./forward-chat.js');
const { AccountRepository } = await import('../db/repositories/accounts.js');

test('HTTP chat route translates stream and non-stream with isolated database', async () => {
  const oldSelect = accountPool.selectAccount, oldSuccess = accountPool.recordSuccess, oldFailure = accountPool.recordFailure, oldFetch = globalThis.fetch;
  let requests = 0, successes = 0;
  const upstream = createServer((_req,res) => {
    requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('data: {"type":"response.output_text.delta","delta":"actual"}\n\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n');
  }).listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const url = `http://127.0.0.1:${(upstream.address() as any).port}`;
  globalThis.fetch = ((input: any, init?: any) => oldFetch(String(input).startsWith('https://chatgpt.com/') ? url : input, init)) as typeof fetch;
  const repo = new AccountRepository();
  const account = repo.create({name:'mock', credentialType:'oauth', credentials:JSON.stringify({kind:'oauth',accessToken:'fake',accountId:'workspace'}),provider:'openai'});
  accountPool.selectAccount = async () => account;
  accountPool.recordSuccess = () => {successes++;};
  accountPool.recordFailure = () => {};
  const app = express(); app.use(express.json()); app.post('/chat', (req,_res,next) => {req.user = {id:'u'} as any; next();}, forwardChat);
  const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/chat`;
  try {
    for (const stream of [false,true]) {
      const response = await oldFetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],stream})});
      assert.equal(response.status,200);
      if (stream) {const text = await response.text(); assert.match(text,/actual/); assert.match(text,/data: \[DONE\]\n\n/);}
      else {const body = await response.json() as any; assert.equal(body.choices[0].message.content,'actual'); assert.equal(body.usage,undefined);}
    }
    assert.equal(requests,2); assert.equal(successes,2);
    const rejected = await oldFetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],tools:[]})});
    assert.equal(rejected.status,400); assert.equal(requests,2);
  } finally {accountPool.selectAccount = oldSelect; accountPool.recordSuccess = oldSuccess; accountPool.recordFailure = oldFailure; globalThis.fetch = oldFetch; server.close(); upstream.close();}
});
