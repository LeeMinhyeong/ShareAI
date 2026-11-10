import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRetryDuration as derive } from '../src/upstream/experimental-retry-duration.ts';
const finite = seconds => ({ kind: 'finite', nanoseconds: BigInt(seconds) * 1000000000n });
const indefinite = { kind: 'indefinite' };
const date = 'Fri, 02 Jan 2026 03:04:05 GMT';

test('HTTP-date duration pads one second before applying the minimum', () => {
  assert.deepEqual(derive({ date, retryAfter: date }), finite(5));
  assert.deepEqual(derive({ date, retryAfter: 'Fri, 02 Jan 2026 03:04:10 GMT' }), finite(6));
  assert.deepEqual(derive({ date, retryAfter: 'Fri, 02 Jan 2026 03:04:11 GMT' }), finite(7));
});

test('long delta strings preserve small values without parsing enormous integers', () => {
  assert.deepEqual(derive({ retryAfter: '0'.repeat(129) + '5' }), finite(5));
  assert.deepEqual(derive({ retryAfter: '0'.repeat(8192) }), finite(5));
  assert.deepEqual(derive({ retryAfter: '0'.repeat(8193) }), indefinite);
  assert.deepEqual(derive({ retryAfter: '0'.repeat(129) + '9223372036' }), finite(9223372036));
  assert.deepEqual(derive({ retryAfter: '0'.repeat(129) + '9223372037' }), indefinite);
  assert.deepEqual(derive({ retryAfter: '9'.repeat(8192) }), indefinite);
});

test('HTTP-date padding is checked against signed 64-bit nanoseconds', () => {
  const base = Date.parse(date);
  const target = seconds => new Date(base + seconds * 1000).toUTCString();
  assert.deepEqual(derive({ date, retryAfter: target(9223372035) }), finite(9223372036));
  assert.deepEqual(derive({ date, retryAfter: target(9223372036) }), indefinite);
});
