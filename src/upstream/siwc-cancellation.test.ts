import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infer } from './inference.js';

test('cancelled SIWC inference does not dispatch an upstream request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('unexpected upstream request');
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(infer('openai', {kind:'siwc', token:'synthetic'}, {
      model:'gpt-5', messages:[{role:'user', content:'hello'}],
    }, undefined, controller.signal));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
