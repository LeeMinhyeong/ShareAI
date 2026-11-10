import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLegacy429 } from '../src/db/experimental-429-legacy-plan.mjs';

const row = {kind:'siwc', account_id:'shared', observed_at:1, until_at:2, revision:4};
test('plans indefinite restrictions preserving colliding IDs and input order', () => {
  assert.deepEqual(planLegacy429(JSON.stringify([row, {...row,kind:'upstream'}])), [
    {kind:'siwc',account_id:'shared',generation:1,duration_ns:null},
    {kind:'upstream',account_id:'shared',generation:2,duration_ns:null},
  ]);
  assert.deepEqual(planLegacy429('[]'), []);
});

test('rejects lone Unicode surrogates in account IDs', () => {
  for (const id of ['\uD800', '\uDC00', 'prefix\uD800suffix']) {
    assert.throws(() => planLegacy429(JSON.stringify([{...row, account_id:id}])), /Malformed legacy row/);
  }
});

test('preserves case-distinct IDs and kinds exactly', () => {
  const inputs = [
    {...row, account_id:'Case'}, {...row, account_id:'case'},
    {...row, kind:'upstream', account_id:'Case'}, {...row, kind:'upstream', account_id:'case'},
  ];
  assert.deepEqual(planLegacy429(JSON.stringify(inputs)), inputs.map(({kind, account_id}, index) => ({
    kind, account_id, generation:index + 1, duration_ns:null,
  })));
});

test('rejects non-JSON and malformed or duplicate rows', () => {
  const invalid = [null, [], '{}', '[', JSON.stringify([row,row]),
    ...[null, {}, {...row,kind:'other'}, {...row,account_id:''}, {...row,account_id:'a\0b'},
      {...row,observed_at:1.5}, {...row,until_at:Number.MAX_SAFE_INTEGER+1},
      {...row,revision:-1}, {...row,revision:'4'}, {...row,extra:true},
      {kind:'siwc',account_id:'x',observed_at:1,until_at:2}].map(x => JSON.stringify([x]))];
  for (const input of invalid) assert.throws(() => planLegacy429(input), undefined, String(input));
  assert.throws(() => planLegacy429('[]', 'extra'));
});
