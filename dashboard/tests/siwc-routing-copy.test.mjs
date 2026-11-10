import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('official account UI does not falsely promise opt-in-only routing', () => {
  const source = readFileSync(new URL('../src/pages/OfficialChatGPT.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /자동으로 선택되지 않습니다/);
  assert.match(source, /자동 선택/);
  assert.match(source, /siwc_account_id/);
  assert.match(source, /특정 계정을 지정하려면/);
});
