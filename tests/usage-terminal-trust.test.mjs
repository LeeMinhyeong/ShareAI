import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infer, strictInference } from '../src/upstream/inference.ts';

const request = {model:'synthetic', messages:[{role:'user',content:'hello'}]};
const frames = values => values.map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join('');
const headers = {'content-type':'text/event-stream'};
const creds = {openai:{kind:'api_key',token:'sk-synthetic'}, anthropic:{kind:'api_key',token:'sk-ant-api-synthetic'}, codex:{kind:'oauth',token:'synthetic',accountId:'synthetic'}};
async function run(protocol, values, strict = false) {
  const provider = protocol === 'anthropic' ? 'anthropic' : 'openai';
  const response = () => new Response(frames(values), {headers});
  let events;
  if (strict) {
    const prior = globalThis.fetch;
    globalThis.fetch = async () => response();
    try { events = await strictInference(provider, creds[protocol], request)(); }
    finally { globalThis.fetch = prior; }
  } else events = await infer(provider, creds[protocol], request, undefined, undefined, async () => response());
  const found = [];
  let failed = false;
  try { for await (const e of events) if (e.usage) found.push(e.usage); } catch { failed = true; }
  return {found, failed};
}
const chat = usage => ({choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}],usage});
const openai = (input, output) => [{choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]}, {choices:[],usage:{prompt_tokens:input,completion_tokens:output}}, '[DONE]'];
const anthropic = (input, output) => [{type:'message_start',message:{id:'m',content:[],usage:{input_tokens:input}}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:output}},{type:'message_stop'}];

test('usage from a choices frame is not emitted when the stream fails before terminal', async () => {
  const input = [chat({prompt_tokens:3,completion_tokens:2}), {error:{message:'synthetic-secret'}}];
  for (const strict of [false,true]) assert.deepEqual(await run('openai',input,strict),{found:[],failed:true});
});

test('usage remains untrusted if malformed data follows terminal', async () => {
  for (const strict of [false,true]) assert.deepEqual(await run('openai',[...openai(3,2),{error:{message:'synthetic-secret'}}],strict),{found:[],failed:true});
});

test('strict and ordinary parsers reject invalid accounting and retain real zero', async () => {
  for (const protocol of ['openai','anthropic']) for (const strict of [false,true]) {
    const fixture = protocol === 'openai' ? openai : anthropic;
    assert.deepEqual((await run(protocol,fixture(0,0),strict)).found,[{input:0,output:0}]);
    assert.deepEqual((await run(protocol,fixture(3,2),strict)).found,[{input:3,output:2}]);
    for (const [input,output] of [['3',2],[-1,2],[1,1.5],[Number.MAX_SAFE_INTEGER+1,0],[Number.MAX_SAFE_INTEGER,1]]) {
      assert.deepEqual((await run(protocol,fixture(input,output),strict)).found,[]);
    }
    // This contract has no partial-usage representation; omission is unknown, not zero.
    assert.deepEqual((await run(protocol,fixture(3,undefined),strict)).found,[]);
  }
});

test('strict Responses usage is validated', async () => {
  // Same text-only strict Responses lifecycle supported by the existing adapter.
  const fixture = (input,output) => [{type:'response.output_text.delta',delta:'hi'},{type:'response.completed',response:{id:'r',status:'completed',usage:{input_tokens:input,output_tokens:output}}}];
  assert.deepEqual((await run('codex',fixture(0,0),true)).found,[{input:0,output:0}]);
  for (const [input,output] of [['3',2],[-1,2],[1,1.5],[Number.MAX_SAFE_INTEGER+1,0],[Number.MAX_SAFE_INTEGER,1]]) assert.deepEqual((await run('codex',fixture(input,output),true)).found,[]);
});
