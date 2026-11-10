import {test} from 'node:test';
import assert from 'node:assert/strict';
import {strictInference, UpstreamError} from '../src/upstream/inference.ts';
import {settleInferenceStream} from '../src/upstream/sse-terminal-adapter.ts';

const request = {model:'test',messages:[{role:'user',content:'hi'}]};
const data = e => `data: ${JSON.stringify(e)}\n\n`;
const chatEnd = data({choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
const start = (provider='openai', kind='api_key') => strictInference(provider,{kind,token:provider === 'anthropic' ? 'sk-ant-api-test' : kind === 'siwc' ? 'synthetic' : 'sk-test'},request);
async function run(body, provider='openai', kind='api_key', callback=()=>{}) {
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response(body,{headers:{'content-type':'text/event-stream'}});
  try { return await settleInferenceStream(start(provider,kind),callback); } finally {globalThis.fetch=old;}
}

test('strict rejects unknown SSE event, data-less frame, and top-level output', async () => {
  for (const s of ['event: surprise\n'+chatEnd, 'event: surprise\n\n'+chatEnd, chatEnd+'event: surprise\n\n', 'id: ignored\n\n'+chatEnd, data({choices:[{delta:{},finish_reason:'stop'}],audio:'lost'})+'data: [DONE]\n\n', data({choices:[{delta:{},finish_reason:'stop',audio:'lost'}]})+'data: [DONE]\n\n']) await assert.rejects(run(s));
  assert.equal((await run(': heartbeat\n\n'+chatEnd)).outcome,'SUCCESS');
  assert.equal((await run('event: message\n'+chatEnd)).outcome,'SUCCESS');
});

test('Anthropic requires indexed ordered block lifecycle', async () => {
  const msg = data({type:'message_start',message:{id:'m',content:[]}});
  const block = i => data({type:'content_block_start',index:i,content_block:{type:'text',text:''}});
  const delta = i => data({type:'content_block_delta',index:i,delta:{type:'text_delta',text:'x'}});
  const stop = i => data({type:'content_block_stop',index:i});
  const end = data({type:'message_delta',delta:{stop_reason:'end_turn'}})+data({type:'message_stop'});
  assert.equal((await run('event: message_start\n'+msg+block(0)+delta(0)+stop(0)+block(1)+stop(1)+end,'anthropic')).outcome,'SUCCESS');
  for (const middle of [delta(0),block(0)+delta(1)+stop(0),block(0)+end,block(0)+stop(0)+stop(0),block(1)+stop(1),block(0)+block(1)+stop(1),block(0)+stop(0)+block(0)]) await assert.rejects(run(msg+middle+end,'anthropic'));
  await assert.rejects(run('event: wrong\n'+msg+block(0)+stop(0)+end,'anthropic'));
});

test('Anthropic documented empty end_turn succeeds but other blockless endings fail', async () => {
  const msg=data({type:'message_start',message:{id:'m',content:[]}});
  const end=reason=>data({type:'message_delta',delta:{stop_reason:reason}})+data({type:'message_stop'});
  assert.equal((await run(msg+end('end_turn'),'anthropic')).outcome,'SUCCESS');
  for(const reason of ['max_tokens','stop_sequence','tool_use']) await assert.rejects(run(msg+end(reason),'anthropic'));
  await assert.rejects(run(msg+data({type:'message_stop'}),'anthropic'));
});

test('unsubstantiated SIWC errors never establish verified 429', async () => {
  for (const e of [{error:{code:'subscription_sharing_usage_limit_exceeded'}},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}]) await assert.rejects(run(data(e),'openai','siwc'));
});

test('HTTP 429 stays verified even if body cancellation fails', async () => {
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){throw new Error('cancel failed');}}),{status:429});
  try { const capability=start(); assert.deepEqual(await settleInferenceStream(capability,()=>{}),{outcome:'UNKNOWN_429'}); await assert.rejects(settleInferenceStream(capability,()=>{}),/already started/); } finally {globalThis.fetch=old;}
});

test('callback 429 is not verified', async () => {
  await assert.rejects(run(data({choices:[{delta:{content:'hi'}}]})+chatEnd,'openai','api_key',()=>{throw new UpstreamError(429,'callback');}),/callback/);
});

test('HTTP 429 disposal does not wait for a hung cancellation', async () => {
  const old=globalThis.fetch;
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}),{status:429});
  try { const result=await Promise.race([settleInferenceStream(start(),()=>{}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),250))]); assert.deepEqual(result,{outcome:'UNKNOWN_429'}); } finally {globalThis.fetch=old;}
});
