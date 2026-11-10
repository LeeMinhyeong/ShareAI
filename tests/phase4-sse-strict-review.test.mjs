import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settleInferenceStream} from '../src/upstream/sse-terminal-adapter.ts';
import {strictInference} from '../src/upstream/inference.ts';
const request = {model:'test', messages:[{role:'user',content:'hi'}]};

test('DONE alone is not a complete chat response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
  try { await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request), () => {})); }
  finally {globalThis.fetch = original;}
});

test('SIWC response.completed requires a successful response body', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"type":"response.completed"}\n\n', {headers:{'content-type':'text/event-stream'}});
  try { await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'siwc',token:'test'},request), () => {})); }
  finally {globalThis.fetch = original;}
});

test('unrecognized output event cannot be silently discarded', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"type":"response.audio.delta","delta":"lost"}\n\ndata: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n', {headers:{'content-type':'text/event-stream'}});
  try { await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'siwc',token:'test'},request), () => {})); }
  finally {globalThis.fetch = original;}
});

test('finish must not reach callback before durable settlement', async () => {
  const original = globalThis.fetch; const seen = [];
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
  try {
    await settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request), e => seen.push(e));
    assert.equal(seen.some(e => e.finish), false);
  } finally {globalThis.fetch = original;}
});

test('arbitrary empty iterable cannot prove upstream completion', async () => {
  await assert.rejects(settleInferenceStream(async () => (async function*(){})(), () => {}));
});

test('untrusted finish cannot escape to a client', async () => {
  const seen = [];
  await assert.rejects(settleInferenceStream(async () => (async function*(){yield {finish:'stop'};})(), e => seen.push(e)));
  assert.deepEqual(seen, []);
});
