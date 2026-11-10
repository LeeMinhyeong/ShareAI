import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {create429Fixture} from './phase4-429-owned-fixture.mjs';

let fixture, closeDatabase, ordinary429Deadline, importStarted=false;
after(()=>{
  let safe=true;
  const errors=[];
  if(closeDatabase) try { closeDatabase(); } catch(e) { errors.push(e); safe=false; }
  else if(importStarted) safe=false;
  if(fixture) try { fixture.cleanup(safe); } catch(e) { errors.push(e); }
  if(errors.length) throw new AggregateError(errors,'429 precision cleanup failed');
});
before(async()=>{
  fixture=create429Fixture(); fixture.enter();
  importStarted=true;
  const client=await import('../src/db/client.ts'); closeDatabase=client.closeDatabase;
  ({ordinary429Deadline} = await import('../src/upstream/forward-chat.ts'));
});

test('provider-relative HTTP date accounts for Date header second precision', () => {
  const now = Date.parse('2026-01-02T03:04:05Z');
  assert.equal(ordinary429Deadline(now, 'Fri, 02 Jan 2026 02:06:05 GMT', 'Fri, 02 Jan 2026 02:04:05 GMT'), now + 121000);
});

test('provider Date allowance respects the safe integer boundary', () => {
  const max=Number.MAX_SAFE_INTEGER, now=max-6500;
  const date='Fri, 02 Jan 2026 02:04:05 GMT';
  assert.equal(ordinary429Deadline(now,'Fri, 02 Jan 2026 02:04:10 GMT',date),max-500);
  assert.equal(ordinary429Deadline(now,'Fri, 02 Jan 2026 02:04:11 GMT',date),max);
  assert.equal(ordinary429Deadline(max-6000,'Fri, 02 Jan 2026 02:04:10 GMT',date),max);
});
