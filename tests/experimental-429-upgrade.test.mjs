import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSynthetic429 } from '../src/db/experimental-429-upgrade.mjs';

const fixture = {
  legacy: [['upstream','same','0'], ['siwc','same','9223372036854775807'], ['upstream','orphan','-1']],
  ordinaryOpen: [['same','ordinary-open'], ['other','ordinary-other']],
  siwcOpen: [['same','siwc-open'], ['other','siwc-other']],
};

test('converts exact legacy keys to indefinite restrictions and preserves all OPEN values', () => {
  const result=convertSynthetic429(JSON.stringify(fixture));
  assert.equal(result.status,'converted');
  assert.equal(result.count,3);
  assert.deepEqual(result.after.rows.legacy_cooldowns,result.before.rows.legacy_cooldowns);
  assert.deepEqual(result.before.rows.legacy_cooldowns,[
    {kind:'upstream',account_id:'same',deadline:0n},
    {kind:'siwc',account_id:'same',deadline:9223372036854775807n},
    {kind:'upstream',account_id:'orphan',deadline:-1n},
  ]);
  assert.deepEqual(result.before.rows.ordinary_account_attempts,[{account_id:'same',attempt_id:'ordinary-open'},{account_id:'other',attempt_id:'ordinary-other'}]);
  assert.deepEqual(result.before.rows.siwc_account_attempts,[{account_id:'same',attempt_id:'siwc-open'},{account_id:'other',attempt_id:'siwc-other'}]);
  assert.deepEqual(result.after.rows.ordinary_account_attempts,result.before.rows.ordinary_account_attempts);
  assert.deepEqual(result.after.rows.siwc_account_attempts,result.before.rows.siwc_account_attempts);
  assert.deepEqual(result.after.rows.experimental_atomic_429_marker,[{id:1n,version:1n,generation:3n}]);
  assert.deepEqual(result.after.rows.experimental_atomic_429_restrictions,[
    {kind:'siwc',account_id:'same',generation:1n,duration_ns:null},
    {kind:'upstream',account_id:'orphan',generation:2n,duration_ns:null},
    {kind:'upstream',account_id:'same',generation:3n,duration_ns:null},
  ]);
  for (const key of ['databases','encoding','userVersion','applicationId','ignoreChecks','journalMode','temp']) assert.deepEqual(result.after[key],result.before[key]);
  for (const name of ['legacy_cooldowns','ordinary_account_attempts','siwc_account_attempts']) assert.deepEqual(result.after.indexes[name],result.before.indexes[name]);
});
