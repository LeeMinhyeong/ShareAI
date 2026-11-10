import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { deriveRetryDuration as derive } from '../src/upstream/experimental-retry-duration.ts';

// Expose the real private parser only in an isolated in-memory test module.
// This avoids widening the experimental module's production exports.
const source = await readFile(new URL('../src/upstream/experimental-retry-duration.ts', import.meta.url), 'utf8');
const testModule = ts.transpileModule(`${source}\nexport { parseHttpDate };`, {
 compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { parseHttpDate } = await import(`data:text/javascript;base64,${Buffer.from(testModule).toString('base64')}`);
const finite = nanoseconds => ({ kind: 'finite', nanoseconds });
const indefinite = { kind: 'indefinite' };
const date = 'Fri, 02 Jan 2026 03:04:05 GMT';
test('delta uses exact bigint and minimum', () => {
 for (const [value, seconds] of [['0', 5n], ['4', 5n], ['5', 5n], ['9223372036', 9223372036n]]) assert.deepEqual(derive({ retryAfter: value }), finite(seconds * 1000000000n), value);
 assert.deepEqual(derive({ retryAfter: '9007199254740993' }), indefinite);
});
test('absence falls back', () => assert.deepEqual(derive({}), finite(5000000000n)));
test('malformed, multi-valued and oversized hints are indefinite', () => {
 for (const retryAfter of ['', '-1', '+1', '1.5', '1s', ' 5', '5 ', '5, 6', '9'.repeat(129), ['5', '6']]) assert.deepEqual(derive({ retryAfter, date }), indefinite, String(retryAfter));
});
test('HTTP date requires valid unambiguous provider Date from same response', () => {
 const retryAfter = 'Fri, 02 Jan 2026 03:06:05 GMT';
 for (const d of [undefined, '', 'bad', [date, date], 'Fri, 02 Jan 2026 03:04:05.001 GMT', 'Friday, 02-Jan-26 03:04:05 GMT']) assert.deepEqual(derive({ retryAfter, date: d }), indefinite, String(d));
 assert.deepEqual(derive({ retryAfter, date }), finite(121000000000n));
});
test('dates cross day boundaries, apply floor, and reject reversed order', () => {
 assert.deepEqual(derive({ date: 'Thu, 01 Jan 2026 23:59:59 GMT', retryAfter: 'Fri, 02 Jan 2026 00:00:06 GMT' }), finite(8000000000n));
 assert.deepEqual(derive({ date, retryAfter: 'Fri, 02 Jan 2026 03:04:06 GMT' }), finite(5000000000n));
 assert.deepEqual(derive({ date, retryAfter: date }), finite(5000000000n));
 assert.deepEqual(derive({ date, retryAfter: 'Fri, 02 Jan 2026 03:04:04 GMT' }), indefinite);
});
test('all three HTTP date forms work with a four-digit provider reference', () => {
 for (const retryAfter of ['Fri, 02 Jan 2026 03:06:05 GMT', 'Friday, 02-Jan-26 03:06:05 GMT', 'Fri Jan  2 03:06:05 2026']) assert.deepEqual(derive({ date, retryAfter }), finite(121000000000n), retryAfter);
 assert.deepEqual(derive({ date: 'Fri Jan  2 03:04:05 2026', retryAfter: 'Fri, 02 Jan 2026 03:06:05 GMT' }), finite(121000000000n));
});
test('far future dates are not shortened', () => {
 assert.deepEqual(derive({ date: 'Fri, 01 Jan 2021 00:00:00 GMT', retryAfter: 'Fri, 31 Dec 9999 23:59:59 GMT' }), indefinite);
});
test('invalid weekdays, calendar, units, leap seconds and milliseconds are indefinite', () => {
 for (const retryAfter of ['Thu, 02 Jan 2026 03:06:05 GMT', 'Fri, 32 Jan 2026 03:06:05 GMT', 'Fri, 02 Jan 2026 03:06:60 GMT', 'Fri, 02 Jan 2026 03:06:05.001 GMT', '2026-01-02T03:06:05Z', 'Fri, 02 Jan 2026 03:06:05 PST']) assert.deepEqual(derive({ date, retryAfter }), indefinite, retryAfter);
});
test('no Date.now or zero-argument Date is used', () => {
 const OriginalDate = globalThis.Date;
 class GuardDate extends OriginalDate {
  constructor(...args) { if (!args.length) throw new Error('wall clock'); super(...args); }
  static now() { throw new Error('wall clock'); }
 }
 globalThis.Date = GuardDate;
 try { assert.deepEqual(derive({ date, retryAfter: 'Fri, 02 Jan 2026 03:06:05 GMT' }), finite(121000000000n)); }
 finally { globalThis.Date = OriginalDate; }
});
test('RFC 850 year interpretation is relative to provider Date', () => {
 assert.deepEqual(derive({ date: 'Sat, 01 Jan 2056 00:00:00 GMT', retryAfter: 'Friday, 01-Jan-06 00:00:00 GMT' }), finite(1577836801000000000n));
});

test('RFC 850 cutoff uses the full provider date and never expires early', () => {
 // RFC 9110 §5.6.7 describes the 50-year rule relative to the current time.
 // This experimental algorithm deliberately uses provider Date as its reference;
 // these assertions do not establish conformance against a local clock.
 // The weekday must match the interpreted year, including after the rollover.
 const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
 const base = Date.UTC(2026, 0, 2, 3, 4, 5);
 const rfc850 = (year, second) => `${weekdays[new Date(Date.UTC(year, 0, 2)).getUTCDay()]}, 02-Jan-76 03:04:${String(second).padStart(2, '0')} GMT`;
 const OriginalDate = globalThis.Date;
 class GuardDate extends OriginalDate {
  constructor(...args) { if (!args.length) throw new Error('wall clock'); super(...args); }
  static now() { throw new Error('wall clock'); }
 }
 globalThis.Date = GuardDate;
 try {
  for (const second of [4, 5]) {
   const target = Date.UTC(2076, 0, 2, 3, 4, second);
   // One second of quantization margin keeps the derived duration conservative.
   const expected = (BigInt(target - base) / 1000n + 1n) * 1000000000n;
   assert.equal(parseHttpDate(rfc850(2076, second), base), target, `parser cutoff ${second}`);
   assert.deepEqual(derive({ date, retryAfter: rfc850(2076, second) }), finite(expected), `cutoff ${second}`);
  }
  // Assert the private parser's exact instant: indefinite alone cannot distinguish
  // a valid 1976 date from rejection of a mismatched weekday in 2076.
  assert.equal(parseHttpDate(rfc850(1976, 6), base), Date.UTC(1976, 0, 2, 3, 4, 6));
  assert.equal(parseHttpDate(rfc850(2076, 6), base), undefined, '2076 weekday is invalid after rollover');
  assert.deepEqual(derive({ date, retryAfter: rfc850(1976, 6) }), indefinite);
 } finally { globalThis.Date = OriginalDate; }
});
