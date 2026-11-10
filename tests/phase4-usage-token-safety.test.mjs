import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infer } from '../src/upstream/inference.ts';
import { responseStream } from './phase4-protocol-fixtures.mjs';

const request = {model:'gpt-test', messages:[{role:'user', content:'hello'}]};
const auth = {kind:'api_key', token:'sk-synthetic', canRefresh:false};
async function parseUsage(input, output) {
  const frames = [
    {choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]},
    {choices:[],usage:{prompt_tokens:input,completion_tokens:output}},
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  const events = await infer('openai', auth, request, undefined, undefined,
    async () => new Response(frames, {headers:{'content-type':'text/event-stream'}}));
  const result = [];
  for await (const event of events) result.push(event);
  return result.find(event => event.usage)?.usage;
}

test('provider token counts cannot inject negative, fractional or unsafe totals into usage', async () => {
  assert.deepEqual(await parseUsage(3, 2), {input:3, output:2});
  for (const [input, output] of [[-1,2], [1,1.5], [Number.MAX_SAFE_INTEGER,1], [Number.MAX_SAFE_INTEGER + 1,0]]) {
    assert.equal(await parseUsage(input, output), undefined);
  }
});

for (const protocol of ['anthropic', 'codex', 'siwc']) {
  test(`${protocol} ignores invalid provider token counts`, async () => {
    async function run(input, output) {
      const frames = protocol === 'anthropic' ? [
        {type:'message_start', message:{id:'m',content:[],usage:{input_tokens:input}}},
        {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:output}},
        {type:'message_stop'},
      ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') :
        responseStream.replace('"status":"completed","output":', `"status":"completed","usage":{"input_tokens":${input},"output_tokens":${output}},"output":`);
      const provider = protocol === 'anthropic' ? 'anthropic' : 'openai';
      const credentials = protocol === 'anthropic' ? {kind:'api_key',token:'sk-ant-api-synthetic'} : protocol === 'codex' ? {kind:'oauth',token:'synthetic',accountId:'synthetic'} : {kind:'siwc',token:'synthetic'};
      const events = await infer(provider, credentials, request, undefined, undefined,
        async () => new Response(frames, {headers:{'content-type':'text/event-stream'}}));
      const result = []; for await (const event of events) result.push(event);
      return result.find(event => event.usage)?.usage;
    }
    assert.deepEqual(await run(3,2), {input:3,output:2});
    for (const [input,output] of [[-1,2],[1,1.5],[Number.MAX_SAFE_INTEGER,1],[Number.MAX_SAFE_INTEGER + 1,0]]) {
      assert.equal(await run(input,output), undefined);
    }
  });
}
