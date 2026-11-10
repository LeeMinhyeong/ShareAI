import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production OAuth module without importing application configuration,
// opening a database, or allowing any network calls.
function loadOAuth(fetcher, clock) {
  class Clock extends Date { static now() { return clock.now; } }
  const modules = { crypto: {}, http: {}, '../utils/logger.js': { logger: {} } };
  const source = readFileSync(new URL('../src/upstream/oauth.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require(name) { if (!(name in modules)) throw Error('Unexpected import'); return modules[name]; }, process: { env: {} }, Date: Clock, AbortController, AbortSignal, URLSearchParams, fetch: fetcher });
  return exports;
}

test('refresh expiration is anchored before response and body delays for both providers', async () => {
  for (const provider of ['openai', 'anthropic']) {
    const clock = { now: 1700000000000 };
    const initial = clock.now;
    let calls = 0;
    const { refreshTokens } = loadOAuth(async () => {
      calls++;
      clock.now += 3000;
      return { ok: true, async text() { clock.now += 4000; return JSON.stringify({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 60 }); } };
    }, clock);
    const result = await refreshTokens(provider, { kind: 'oauth', accessToken: 'old-token', refreshToken: 'old-refresh' });
    assert.equal(calls, 1);
    assert.equal(result.refreshToken, 'new-refresh');
    assert.equal(result.expiresAt, initial + 60000);
  }
});

test('a response arriving after its conservative expiry preserves the rotated token', async () => {
  const clock = { now: 1700000000000 };
  const start = clock.now;
  const { refreshTokens } = loadOAuth(async () => ({
    ok: true,
    async text() {
      clock.now += 12000;
      return JSON.stringify({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 5 });
    },
  }), clock);
  const result = await refreshTokens('anthropic', { kind: 'oauth', accessToken: 'old-token', refreshToken: 'old-refresh' });
  assert.equal(result.expiresAt, start + 5000);
  assert.ok(result.expiresAt < clock.now);
  assert.equal(result.refreshToken, 'new-refresh');
});
