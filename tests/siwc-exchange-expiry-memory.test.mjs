import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadExchange(clock) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const jose = {
    decodeProtectedHeader: () => ({ alg: 'RS256', kid: 'synthetic' }),
    createLocalJWKSet: () => ({}),
    jwtVerify: async () => ({ payload: { sub: 'synthetic-subject', nonce: 'synthetic-nonce', iat: 1 } }),
  };
  const source = readFileSync(new URL('../src/upstream/siwc.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) { if (name === 'jose') return jose; if (name === 'node:crypto') return {}; throw Error('Unexpected import'); }, Date: Clock, URL, URLSearchParams });
  return exports.exchangeSiwcCode;
}

test('SIWC exchange expiration starts before token response and body delays', async () => {
  const clock = { now: 1700000000000 };
  const start = clock.now;
  const exchange = loadExchange(clock);
  let calls = 0;
  const credential = await exchange({ mode: 'registration', code: 'synthetic-code', clientId: 'synthetic-client', nonce: 'synthetic-nonce', verifier: 'a'.repeat(43), redirectUri: 'http://127.0.0.1:1234/auth/callback' }, async url => {
    calls++;
    if (url.endsWith('/oauth/token')) {
      clock.now += 3000;
      return { status: 200, async json() { clock.now += 4000; return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', id_token: 'synthetic-id', token_type: 'Bearer', expires_in: 5, scope: 'offline_access chatgpt.tokens.use.direct' }; } };
    }
    assert.equal(url, 'https://auth.openai.com/.well-known/jwks.json');
    clock.now += 2000;
    return { status: 200, async json() { return {}; } };
  });
  assert.equal(calls, 2);
  assert.equal(Date.parse(credential.savedAt), start);
  assert.equal(credential.expiresIn, 5);
  assert.ok(Date.parse(credential.savedAt) + credential.expiresIn * 1000 < clock.now);
  assert.equal(credential.refreshToken, 'synthetic-refresh');
});
