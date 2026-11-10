import test from 'node:test';
import assert from 'node:assert/strict';
import * as siwc from '../src/upstream/siwc.ts';
import { generateKeyPairSync, sign } from 'node:crypto';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format:'jwk'}), kid:'test-key', alg:'RS256', use:'sig'};
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now()/1000);
function token(claims = {}, header = {}) {
  const content = `${enc({alg:'RS256',kid:'test-key',...header})}.${enc({iss:'https://auth.openai.com',aud:'oaiapp_fake',sub:'fake-sub',nonce:'fake',iat:now,exp:now+300,...claims})}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}
const attempt = {mode:'registration', code:'fake', clientId:'oaiapp_fake', redirectUri:'http://127.0.0.1:54321/auth/callback', verifier:'x'.repeat(43), nonce:'fake'};
function provider(id = token()) {
  return async (url, init) => {
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({keys:[jwk]});
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), attempt.clientId);
    assert.equal(form.get('code_verifier'), attempt.verifier);
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    return Response.json({access_token:'access',refresh_token:'refresh',id_token:id,token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'});
  };
}

test('exchange retains receipt timestamp and earliest refresh metadata', async () => {
  const before = Date.now();
  const f = provider();
  const timed = async (url, init) => {
    const response = await f(url, init);
    if (!url.endsWith('/token')) return response;
    const data = await response.json(); data.earliest_refresh_at = 1790033000;
    return Response.json(data);
  };
  const result = await siwc.exchangeSiwcCode({...attempt, mode:'registration'}, timed);
  assert.ok(Date.parse(result.savedAt) >= before && Date.parse(result.savedAt) <= Date.now());
  assert.equal(result.earliestRefreshAt, 1790033000);
});

test('exchange rejects malformed earliest refresh metadata', async () => {
  const base = provider();
  const bad = async (url, init) => {
    const response = await base(url,init);
    if (!url.endsWith('/token')) return response;
    const data = await response.json(); data.earliest_refresh_at = 'invalid';
    return Response.json(data);
  };
  await assert.rejects(siwc.exchangeSiwcCode(attempt,bad), /SIWC exchange failed/);
});

test('invalid_grant exposes only provisional issued client for fresh authorization', async () => {
  const f = async () => Response.json({error:'invalid_grant', error_description:'secret'}, {status:400});
  await assert.rejects(siwc.exchangeSiwcCode({...attempt, mode:'registration'}, f), e => e.code === 'invalid_grant' && e.clientId === 'oaiapp_fake' && !JSON.stringify(e).includes('fake-sub') && !e.message.includes('secret'));
});

test('valid identity survives missing direct or offline scope', async () => {
  for (const [scope, planEnabled, renewable] of [['openid offline_access resource.invoke', false, true], ['openid resource.invoke chatgpt.tokens.use.direct', true, false]]) {
    const f = provider();
    const limited = async (url, init) => {
      const response = await f(url, init);
      if (!url.endsWith('/token')) return response;
      const data = await response.json(); data.scope = scope;
      if (!renewable) delete data.refresh_token;
      return Response.json(data);
    };
    const result = await siwc.exchangeSiwcCode({...attempt, mode:'registration'}, limited);
    assert.equal(result.subject, 'fake-sub');
    assert.equal(result.planEnabled, planEnabled);
    assert.equal(result.renewable, renewable);
  }
});

test('returning exchange rejects missing or mismatched selected identity', async () => {
  for (const expectedIdentity of [undefined, {issuer:'https://evil.example',clientId:'oaiapp_fake',subject:'fake-sub'}, {issuer:'https://auth.openai.com',clientId:'other',subject:'fake-sub'}, {issuer:'https://auth.openai.com',clientId:'oaiapp_fake',subject:'other'}]) {
    await assert.rejects(siwc.exchangeSiwcCode({...attempt, mode:'returning', expectedIdentity}, provider()), /SIWC exchange failed/);
  }
});

test('exchange accepts a correctly signed and scoped synthetic ID token', async () => {
  const result = await siwc.exchangeSiwcCode(attempt, provider());
  assert.equal(result.subject, 'fake-sub');
  assert.equal(result.accessToken, 'access');
});

test('exchange rejects OAuth failure without leaking provider details', async () => {
  assert.equal(typeof siwc.exchangeSiwcCode, 'function');
  const fetcher = async () => new Response(JSON.stringify({error: 'secret-provider-detail'}), {status: 400});
  await assert.rejects(siwc.exchangeSiwcCode(attempt, fetcher), e => !e.message.includes('secret-provider-detail'));
});

test('rejects invalid signed identity claims and headers', async () => {
  const cases = [
    token({iss:'https://evil.example'}), token({aud:'wrong'}), token({nonce:'wrong'}),
    token({exp:now-20}), token({iat:now+60}), token({nbf:now+60}), token({sub:''}),
    token({aud:['oaiapp_fake','other']}), token({azp:'other'}),
    token({}, {alg:'HS256'}), token({}, {kid:'missing'}), token({}, {jku:'https://evil.example/jwks'}),
  ];
  const good = token();
  cases.push(good.slice(0, -5) + 'xxxxx');
  for (const jwt of cases) await assert.rejects(siwc.exchangeSiwcCode(attempt, provider(jwt)), /SIWC exchange failed/);
  await assert.rejects(siwc.exchangeSiwcCode({...attempt, mode:'returning', expectedIdentity:{issuer:'https://auth.openai.com',clientId:'oaiapp_fake',subject:'other'}}, provider()), /SIWC exchange failed/);
});

test('rejects malformed JWKS, OAuth error and malformed refresh token', async () => {
  for (const mode of ['jwks', 'error', 'refresh']) {
    const f = provider();
    const bad = async (url, init) => {
      if (url.endsWith('jwks.json') && mode === 'jwks') return Response.json({keys:[]});
      const response = await f(url, init);
      if (url.endsWith('/token')) {
        const data = await response.json();
        if (mode === 'error') data.error = 'error-with-secret';
        if (mode === 'refresh') data.refresh_token = '';
        return Response.json(data);
      }
      return response;
    };
    await assert.rejects(siwc.exchangeSiwcCode(attempt, bad), /SIWC exchange failed/);
  }
});

test('fetches fresh JWKS on each exchange for rotation', async () => {
  let keys = 0;
  const rotated = generateKeyPairSync('rsa', {modulusLength: 2048});
  const rotatedKey = {...rotated.publicKey.export({format:'jwk'}), kid:'new-key', alg:'RS256', use:'sig'};
  const original = token();
  const parts = original.split('.');
  const input = `${enc({alg:'RS256',kid:'new-key'})}.${parts[1]}`;
  const rotatedToken = `${input}.${sign('RSA-SHA256', Buffer.from(input), rotated.privateKey).toString('base64url')}`;
  let current = original;
  const f = async (url, init) => {
    if (url.endsWith('jwks.json')) { keys++; return Response.json({keys: [keys === 1 ? jwk : rotatedKey]}); }
    return provider(current)(url, init);
  };
  await siwc.exchangeSiwcCode(attempt, f);
  current = rotatedToken;
  await siwc.exchangeSiwcCode(attempt, f);
  assert.equal(keys, 2);
});
