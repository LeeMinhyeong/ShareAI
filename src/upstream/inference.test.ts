import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { infer } from './inference.js';

test('Codex OAuth streams real response events and usage over HTTP', async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"response.output_text.delta","delta":"hel');
    res.write('lo"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":2,"output_tokens":1}}}\n\n');
    res.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as any).port;
    const result = await infer('openai', {kind:'oauth', token:'fake', accountId:'workspace', canRefresh:false}, {model:'gpt-5', messages:[{role:'user',content:'hi'}]}, `http://127.0.0.1:${port}`);
    const events = []; for await (const event of result) events.push(event);
    assert.equal(received.headers.authorization, 'Bearer fake');
    assert.equal(received.headers['chatgpt-account-id'], 'workspace');
    assert.equal(received.body.stream, true);
    assert.equal(received.body.store, false);
    assert.equal(events[0].text, 'hello');
    assert.deepEqual(events.at(-1)?.usage, {input:2, output:1});
  } finally { server.close(); }
});

test('Claude OAuth separates system and parses SSE usage', async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = {headers:req.headers, body:JSON.parse(body)};
    res.writeHead(200, {'content-type':'text/event-stream'});
    for (const e of [
      {type:'message_start',message:{id:'msg_1',usage:{input_tokens:5}}},
      {type:'content_block_start',content_block:{type:'text',text:''}},
      {type:'content_block_delta',delta:{type:'text_delta',text:'hello'}},
      {type:'message_delta',delta:{stop_reason:'max_tokens'},usage:{output_tokens:3}},
      {type:'message_stop'}
    ]) res.write(`data: ${JSON.stringify(e)}\r\n\r\n`);
    res.end();
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const events = await infer('anthropic', {kind:'oauth',token:'fake',canRefresh:false}, {model:'claude-x',messages:[{role:'system',content:'rules'},{role:'user',content:'hi'}]}, `http://127.0.0.1:${(server.address() as any).port}`);
    const result = []; for await (const e of events) result.push(e);
    assert.equal(received.headers.authorization,'Bearer fake');
    assert.match(received.headers['anthropic-beta'], /oauth-2025-04-20/);
    assert.equal(received.body.system[0].text,"You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(received.body.system[1].text,'rules');
    assert.deepEqual(received.body.messages,[{role:'user',content:'hi'}]);
    assert.equal(result.find(e => e.text)?.text,'hello');
    assert.equal(result.find(e => e.finish)?.finish,'length');
    assert.deepEqual(result.at(-1)?.usage,{input:5,output:3});
  } finally {server.close();}
});

test('reject unsupported credentials and truncated streams', async () => {
  await assert.rejects(() => infer('openai', {kind:'oauth',token:'fake',canRefresh:false}, {model:'gpt-5',messages:[{role:'user',content:'x'}]}), /account ID/);
  await assert.rejects(() => infer('anthropic', {kind:'cookie' as any,token:'fake',canRefresh:false}, {model:'claude',messages:[{role:'user',content:'x'}]}), /Unsupported/);
  const server = createServer((_req,res) => {res.writeHead(200,{'content-type':'text/event-stream'}); res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');}).listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const events = await infer('openai',{kind:'oauth',token:'fake',accountId:'w',canRefresh:false},{model:'gpt-5',messages:[{role:'user',content:'x'}]},`http://127.0.0.1:${(server.address() as any).port}`);
    await assert.rejects(async () => {for await (const _ of events) {}}, /prematurely/);
  } finally {server.close();}
});
