import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertSynthetic429 } from '../src/db/experimental-429-upgrade.mjs';

const fixture = () => ({legacy:[['siwc','valid','-9223372036854775808']], ordinaryOpen:[['one','open-one'],['two','open-two']], siwcOpen:[['one','siwc-one'],['two','siwc-two']]});
for (const [name, mutate, reason] of [
  ['unknown kind', f=>f.legacy.push(['other','x','1']), /Malformed legacy row/],
  ['empty id', f=>f.legacy.push(['upstream','','1']), /Malformed legacy row/],
  ['NUL id', f=>f.legacy.push(['siwc','a\0b','1']), /Malformed legacy row/],
  ['oversize id', f=>f.legacy.push(['siwc','x'.repeat(513),'1']), /Malformed legacy row/],
  ['malformed ordinary OPEN', f=>f.ordinaryOpen.push(['bad','']), /Malformed OPEN row/],
  ['malformed siwc OPEN', f=>f.siwcOpen.push(['bad','']), /Malformed OPEN row/],
]) test(`reject ${name} and preserve complete snapshot`,()=>{
  const f=fixture(); mutate(f);
  const result=convertSynthetic429(JSON.stringify(f));
  assert.equal(result.status,'rejected'); assert.match(result.reason,reason);
  assert.equal(result.wroteBeforeFailure,false);
  assert.deepEqual(result.after,result.before);
  assert.deepEqual(result.before.rows.legacy_cooldowns[0],{kind:'siwc',account_id:'valid',deadline:-9223372036854775808n});
  assert.deepEqual(result.before.rows.ordinary_account_attempts.slice(0,2),[{account_id:'one',attempt_id:'open-one'},{account_id:'two',attempt_id:'open-two'}]);
  assert.deepEqual(result.before.rows.siwc_account_attempts.slice(0,2),[{account_id:'one',attempt_id:'siwc-one'},{account_id:'two',attempt_id:'siwc-two'}]);
});

test('fixture-only injected failure after writes rolls back schema, metadata and all rows',()=>{
  const f=fixture(); f.failAfterWrites=true;
  const result=convertSynthetic429(JSON.stringify(f));
  assert.equal(result.status,'rejected');
  assert.match(result.reason,/Injected fixture failure after writes/);
  assert.equal(result.wroteBeforeFailure,true);
  assert.deepEqual(result.after,result.before);
  assert.deepEqual(result.before.rows.ordinary_account_attempts,[{account_id:'one',attempt_id:'open-one'},{account_id:'two',attempt_id:'open-two'}]);
  assert.deepEqual(result.before.rows.siwc_account_attempts,[{account_id:'one',attempt_id:'siwc-one'},{account_id:'two',attempt_id:'siwc-two'}]);
});

for (const key of ['db','sql','callback','attach','temp','triggers','user_version','backupVerified']) test(`reject unsupported ${key} field`,()=>{
  const f=fixture(); f[key]='CREATE TRIGGER arbitrary';
  assert.throws(()=>convertSynthetic429(JSON.stringify(f)),/Unexpected fixture fields/);
});
for (const deadline of ['oops','1.5','9223372036854775808','-9223372036854775809']) test(`reject invalid fixture integer ${deadline}`,()=>{
  const f=fixture(); f.legacy[0][2]=deadline;
  assert.throws(()=>convertSynthetic429(JSON.stringify(f)),/Invalid integer|Integer out of range/);
});
test('reject non-boolean failure injection',()=>{const f=fixture();f.failAfterWrites='yes';assert.throws(()=>convertSynthetic429(JSON.stringify(f)),/Invalid failure flag/);});
