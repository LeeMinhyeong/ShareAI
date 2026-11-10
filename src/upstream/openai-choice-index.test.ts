import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infer, strictInference, UpstreamError } from './inference.js';

async function stream(index: unknown) {
  const events = [
    {id:'fixture', choices:[{index, delta:{content:'hello'}, finish_reason:null}]},
    {id:'fixture', choices:[{index, delta:{}, finish_reason:'stop'}]},
  ];
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const response = new Response(body, {headers:{'content-type':'text/event-stream'}});
  const generator = await infer('openai', {kind:'api_key',token:'sk-fixture',canRefresh:false},
    {model:'fixture',messages:[{role:'user',content:'hello'}]}, undefined, undefined, async () => response);
  const result = [];
  for await (const event of generator) result.push(event);
  return result;
}

test('OpenAI stream rejects a nonzero choice index instead of treating it as choice zero', async () => {
  for (const index of [1, -1, '0', null]) {
    await assert.rejects(stream(index), (error: unknown) => error instanceof UpstreamError && error.status === 502);
  }
  assert.ok((await stream(0)).some(event => event.text === 'hello'));
  assert.ok((await stream(undefined)).some(event => event.text === 'hello'));
});

const choice = (index: unknown, content: string, finish: string | null = null) => ({index, delta:{content}, finish_reason:finish});
async function collect(strict: boolean, choices: unknown[][]) {
  const body = choices.map(c => `data: ${JSON.stringify({id:'fixture', choices:c})}\n\n`).join('') + 'data: [DONE]\n\n';
  const response = new Response(body, {headers:{'content-type':'text/event-stream'}});
  const original = globalThis.fetch;
  const emitted: {text?: string; finish?: string}[] = [];
  try {
    globalThis.fetch = async () => response;
    const auth = {kind:'api_key' as const, token:'sk-fixture', canRefresh:false};
    const request = {model:'fixture', messages:[{role:'user',content:'hello'}]};
    const generator = strict ? await strictInference('openai', auth, request)() : await infer('openai', auth, request, undefined, undefined, async () => response);
    try { for await (const event of generator) emitted.push(event); return {emitted, error:undefined}; }
    catch (error) { return {emitted, error}; }
  } finally { globalThis.fetch = original; }
}

test('both parsers reject invalid choice indexes before emitting their text', async () => {
  for (const strict of [false, true]) for (const index of [1, -1, '0', null]) {
    const {emitted, error} = await collect(strict, [[choice(0, 'valid')], [choice(index, 'invalid', 'stop')]]);
    assert.ok(error instanceof UpstreamError && error.status === 502, `strict=${strict}, index=${String(index)}`);
    assert.deepEqual(emitted.filter(e => e.text).map(e => e.text), ['valid']);
    assert.ok(!emitted.some(e => e.finish));
  }
});

test('both parsers accept zero or missing index and reject empty or duplicate choices', async () => {
  for (const strict of [false, true]) {
    for (const index of [0, undefined]) {
      const {emitted, error} = await collect(strict, [[choice(index, 'hello')], [choice(index, '', 'stop')]]);
      assert.equal(error, undefined);
      assert.ok(emitted.some(e => e.text === 'hello'));
      assert.ok(emitted.some(e => e.finish === 'stop'));
    }
    for (const choices of [[], [choice(0, 'bad'), choice(0, 'bad')]]) {
      const {emitted, error} = await collect(strict, [choices]);
      assert.ok(error instanceof UpstreamError && error.status === 502);
      assert.ok(!emitted.some(e => e.text || e.finish));
    }
  }
});
