import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '../src/db/durable-ledger-foundation.ts';

// A stateless fence cannot establish a committed, unused claim.
test('stateless dispatch fence is not exported', () => {
  assert.equal('createOpenAttemptDispatchFence' in ledger, false);
  assert.equal(typeof ledger.dispatchOpenAttemptOnce, 'function');
});