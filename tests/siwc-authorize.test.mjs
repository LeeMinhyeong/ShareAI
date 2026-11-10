import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

test('SIWC first registration creates independent nonce, state and S256 PKCE', async () => {
  const module = await import('../src/upstream/siwc.ts').catch(() => null);
  assert.ok(module, 'SIWC authorization builder is not implemented');
  const hostId = 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012';
  const a = module.createSiwcAuthorization({ hostId, redirectUri: 'http://127.0.0.1:54321/auth/callback' });
  const b = module.createSiwcAuthorization({ hostId, redirectUri: 'http://127.0.0.1:54321/auth/callback' });
  const url = new URL(a.url);
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'ShareAI');
  assert.equal(url.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:54321/auth/callback');
  assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(a.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'), a.state);
  assert.equal(url.searchParams.get('nonce'), a.nonce);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.verifier, b.verifier);
});

test('SIWC reauthorization keeps issued client and omits registration hint', async () => {
  const { createSiwcAuthorization } = await import('../src/upstream/siwc.ts');
  const a = createSiwcAuthorization({ hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback', clientId: 'oaiapp_test' });
  const params = new URL(a.url).searchParams;
  assert.equal(params.get('client_id'), 'oaiapp_test');
  assert.equal(params.has('agent_name_hint'), false);
});

test('returning hints are encoded only for issued client and redacted in diagnostics', async () => {
  const { createSiwcAuthorization } = await import('../src/upstream/siwc.ts');
  const { inspect } = await import('node:util');
  const base = {hostId:'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri:'http://127.0.0.1:54321/auth/callback'};
  assert.throws(() => createSiwcAuthorization({...base, idTokenHint:'secret-id-token'}));
  const a = createSiwcAuthorization({...base, clientId:'oaiapp_test', idTokenHint:'secret-id-token', loginHint:'person@example.com'});
  const params = new URL(a.url).searchParams;
  assert.equal(params.get('id_token_hint'), 'secret-id-token');
  assert.equal(params.get('login_hint'), 'person@example.com');
  assert.ok(!inspect(a).includes('secret-id-token'));
  assert.ok(!JSON.stringify(a).includes('secret-id-token'));
});

test('SIWC rejects invalid callback, host, and placeholder issued client', async () => {
  const { createSiwcAuthorization } = await import('../src/upstream/siwc.ts');
  const good = { hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback' };
  for (const redirectUri of ['http://localhost:54321/auth/callback', 'http://127.0.0.1:54321/callback', 'https://127.0.0.1:54321/auth/callback', 'http://127.0.0.1:54321/auth/callback?code=x']) {
    assert.throws(() => createSiwcAuthorization({ ...good, redirectUri }));
  }
  assert.throws(() => createSiwcAuthorization({ ...good, hostId: 'someone@example.com' }));
  assert.throws(() => createSiwcAuthorization({ ...good, clientId: 'dynamic_agent_client' }));
});
