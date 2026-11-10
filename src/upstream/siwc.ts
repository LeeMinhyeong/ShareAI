import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';

export class SiwcInvalidGrantError extends Error {
  readonly code = 'invalid_grant';
  constructor(readonly clientId: string, readonly definitiveRefusal = false) { super('SIWC authorization code expired or invalid; start a fresh authorization'); }
}

export type SiwcIdentity = { issuer: string; clientId: string; subject: string };
type ExchangeAttempt = { code: string; clientId: string; redirectUri: string; verifier: string; nonce: string } & (
  | { mode: 'registration'; expectedIdentity?: never }
  | { mode: 'returning'; expectedIdentity: SiwcIdentity }
);

export async function exchangeSiwcCode(
  attempt: ExchangeAttempt,
  fetcher: typeof fetch = fetch,
) {
  try {
    if (!attempt.code || !attempt.clientId || attempt.clientId === 'dynamic_agent_client' || !attempt.nonce || !/^[A-Za-z0-9._~-]{43,128}$/.test(attempt.verifier)) throw new Error();
    if (attempt.mode !== 'registration' && attempt.mode !== 'returning') throw new Error();
    if (attempt.mode === 'returning' && (!attempt.expectedIdentity || attempt.expectedIdentity.issuer !== 'https://auth.openai.com' || attempt.expectedIdentity.clientId !== attempt.clientId || !attempt.expectedIdentity.subject?.trim())) throw new Error();
    const uri = new URL(attempt.redirectUri);
    if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || !uri.port || uri.pathname !== '/auth/callback' || uri.search || uri.hash || uri.username || uri.password) throw new Error();
    // The token may already be aging while the request and response are in flight.
    const savedAt = new Date().toISOString();
    const response = await fetcher('https://auth.openai.com/api/accounts/oauth/token', {
      method: 'POST', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: attempt.code, client_id: attempt.clientId, redirect_uri: attempt.redirectUri, code_verifier: attempt.verifier, resource: 'https://api.openai.com/v1' }),
    });
    if (response.status !== 200) {
      if (response.status === 400) {
        const error = await response.json() as Record<string, unknown>;
        if (error.error === 'invalid_grant') throw new SiwcInvalidGrantError(attempt.clientId, !response.redirected && !['access_token', 'refresh_token', 'id_token'].some(key => Object.hasOwn(error, key)));
      }
      throw new Error();
    }
    const tokens = await response.json() as Record<string, unknown>;
    if (tokens.error !== undefined || typeof tokens.access_token !== 'string' || !tokens.access_token || (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)) || typeof tokens.id_token !== 'string' || !tokens.id_token || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' || typeof tokens.expires_in !== 'number' || !Number.isSafeInteger(tokens.expires_in) || tokens.expires_in <= 0 || typeof tokens.scope !== 'string') throw new Error();
    if (tokens.earliest_refresh_at !== undefined && (typeof tokens.earliest_refresh_at !== 'number' || !Number.isSafeInteger(tokens.earliest_refresh_at) || tokens.earliest_refresh_at < 0)) throw new Error();
    const scopes = tokens.scope.split(/\s+/).filter(Boolean);
    const renewable = scopes.includes('offline_access') && typeof tokens.refresh_token === 'string';
    const planEnabled = scopes.includes('chatgpt.tokens.use.direct');
    const header = decodeProtectedHeader(tokens.id_token);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) throw new Error();
    const keyResponse = await fetcher('https://auth.openai.com/.well-known/jwks.json', { method: 'GET', redirect: 'error', headers: { accept: 'application/json' } });
    if (keyResponse.status !== 200) throw new Error();
    const jwks = await keyResponse.json() as Parameters<typeof createLocalJWKSet>[0];
    const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { algorithms: ['RS256'], issuer: 'https://auth.openai.com', audience: attempt.clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.nonce !== attempt.nonce || typeof payload.iat !== 'number' || payload.iat > now + 5 || (attempt.mode === 'returning' && payload.sub !== attempt.expectedIdentity.subject) || (payload.sid !== undefined && (typeof payload.sid !== 'string' || !payload.sid.trim()))) throw new Error();
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== attempt.clientId) throw new Error();
    if (payload.azp !== undefined && payload.azp !== attempt.clientId) throw new Error();
    return { subject: payload.sub, issuer: 'https://auth.openai.com', clientId: attempt.clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, tokenType: 'Bearer', expiresIn: tokens.expires_in, scopes, planEnabled, renewable, savedAt, earliestRefreshAt: tokens.earliest_refresh_at };
  } catch (error) {
    if (error instanceof SiwcInvalidGrantError) throw error;
    throw new Error('SIWC exchange failed');
  }
}

// Standalone authorization preparation only. This is not a complete OAuth flow.
// Callers must persist the host ID before calling and start the listener first.
export function createSiwcAuthorization(options: { hostId: string; redirectUri: string; clientId?: string; idTokenHint?: string; loginHint?: string }) {
  if ((options.idTokenHint !== undefined || options.loginHint !== undefined) && !options.clientId) throw new Error('Hints require an issued client ID');
  if ((options.idTokenHint !== undefined && (typeof options.idTokenHint !== 'string' || !options.idTokenHint.trim())) || (options.loginHint !== undefined && (typeof options.loginHint !== 'string' || !options.loginHint.trim()))) throw new Error('Invalid SIWC hint');
  if (options.clientId !== undefined && (!options.clientId.trim() || options.clientId === 'dynamic_agent_client')) {
    throw new Error('Invalid issued client ID');
  }
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.hostId)) {
    throw new Error('Expected a persisted UUIDv4 host ID');
  }
  const uri = new URL(options.redirectUri);
  if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || !uri.port || uri.pathname !== '/auth/callback' || uri.search || uri.hash || uri.username || uri.password) {
    throw new Error('Invalid loopback callback URI');
  }
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    client_id: options.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: options.hostId, response_type: 'code', redirect_uri: options.redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: 'https://api.openai.com/v1', state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  if (!options.clientId) params.set('agent_name_hint', 'ShareAI');
  if (options.idTokenHint !== undefined) params.set('id_token_hint', options.idTokenHint);
  if (options.loginHint !== undefined) params.set('login_hint', options.loginHint);
  // This URL contains sensitive hints: pass directly to the system browser, never log it.
  const url = `https://auth.openai.com/api/accounts/authorize?${params}`;
  const result = { state, nonce, verifier } as { url: string; state: string; nonce: string; verifier: string };
  Object.defineProperty(result, 'url', { value: url, enumerable: false });
  return result;
}
