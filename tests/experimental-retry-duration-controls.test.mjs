import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRetryDuration as derive } from '../src/upstream/experimental-retry-duration.ts';

const indefinite = { kind: 'indefinite' };
const finite = { kind: 'finite', nanoseconds: 121000000000n };
const base = 'Fri, 02 Jan 2026 03:04:05 GMT';
const baseAsc = 'Fri Jan  2 03:04:05 2026';
const targets = [
  'Fri, 02 Jan 2026 03:06:05 GMT',
  'Friday, 02-Jan-26 03:06:05 GMT',
  'Fri Jan  2 03:06:05 2026',
];
const mutations = [
  ['suffix LF', s => s + '\n'], ['suffix CR', s => s + '\r'],
  ['suffix CRLF', s => s + '\r\n'], ['suffix U+2028', s => s + '\u2028'],
  ['suffix U+2029', s => s + '\u2029'], ['leading LF', s => '\n' + s],
  ['suffix NUL', s => s + '\0'], ['embedded LF', s => s.slice(0, 2) + '\n' + s.slice(2)],
  ['leading space', s => ' ' + s], ['suffix space', s => s + ' '],
];

test('numeric Retry-After rejects control characters and surrounding spaces', async t => {
  for (const [label, mutate] of mutations) await t.test(label, () => {
    assert.deepEqual(derive({ retryAfter: mutate('9'), date: base }), indefinite);
  });
});

test('all supported Retry-After dates reject control characters and surrounding spaces', async t => {
  for (const target of targets) for (const [label, mutate] of mutations) await t.test(`${target}: ${label}`, () => {
    assert.deepEqual(derive({ retryAfter: mutate(target), date: base }), indefinite);
  });
});

test('both unambiguous provider Date formats reject control characters and surrounding spaces', async t => {
  for (const date of [base, baseAsc]) for (const [label, mutate] of mutations) await t.test(`${date}: ${label}`, () => {
    assert.deepEqual(derive({ retryAfter: targets[1], date: mutate(date) }), indefinite);
  });
});

test('mixed malformed provider Date and Retry-After remain indefinite', () => {
  assert.deepEqual(derive({ date: base + '\n', retryAfter: targets[1] + '\r' }), indefinite);
  assert.deepEqual(derive({ date: baseAsc + '\u2028', retryAfter: targets[2] + '\u2029' }), indefinite);
});

test('valid date formats and their required internal spaces remain accepted', () => {
  for (const date of [base, baseAsc]) for (const retryAfter of targets) {
    assert.deepEqual(derive({ date, retryAfter }), finite);
  }
  assert.deepEqual(derive({ retryAfter: '9' }), { kind: 'finite', nanoseconds: 9000000000n });
});
