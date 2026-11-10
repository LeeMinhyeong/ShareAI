import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRetryDuration } from '../src/upstream/experimental-retry-duration.ts';

const finite = nanoseconds => ({ kind: 'finite', nanoseconds });
test('delta seconds preserve the 5-second minimum', () => {
  assert.deepEqual(deriveRetryDuration({ retryAfter: '9' }), finite(9000000000n));
});
