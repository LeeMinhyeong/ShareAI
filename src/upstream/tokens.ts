/**
 * 계정별 access token 확보 (만료 임박 시 자동 갱신, 계정별 직렬화)
 */
import type { UpstreamAccount } from '../db/schema.js';
import { AccountRepository, RefreshIntentError } from '../db/repositories/accounts.js';
import { logger } from '../utils/logger.js';
import { decodeJwt, parseStoredCredentials, refreshTokens, type OAuthCredentials, type OAuthProvider } from './oauth.js';

const repo = new AccountRepository();
const inflight = new Map<string, Promise<{ credentials: OAuthCredentials; account: UpstreamAccount }>>();
const refreshKey = (account: UpstreamAccount) => JSON.stringify([account.id, account.credentialRevision, account.credentials]);
let stopping = false;

// Block new exchanges before taking the snapshot; existing exchanges must persist
// their rotated token before the database is closed.
export async function drainTokenRefreshes(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...inflight.values()]);
}
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface ResolvedAuth {
  kind: 'oauth' | 'api_key';
  token: string;
  accountId?: string | null; // ChatGPT workspace id
  canRefresh: boolean;
  observedAccount: UpstreamAccount;
}

export async function resolveAuth(account: UpstreamAccount, opts: { forceRefresh?: boolean; rejectedToken?: string } = {}): Promise<ResolvedAuth> {
  if (stopping) throw new Error('Token refresh unavailable during shutdown');
  const currentAccount = repo.findById(account.id);
  if (!currentAccount || !['active', 'quota_exceeded'].includes(currentAccount.status)) throw new Error('Account unavailable');
  // An internal rotation already answered this rejection; an administrative
  // replacement is a distinct opportunity even when its access token matches.
  const internallyRotated = !!opts.forceRefresh && currentAccount.credentialRevision !== account.credentialRevision && currentAccount.lastRefreshRevision === currentAccount.credentialRevision;
  account = currentAccount;
  const creds = parseStoredCredentials(account.credentials);
  if (!creds) {
    // api_key / 레거시 문자열 자격증명
    return { kind: 'api_key', token: account.credentials, canRefresh: false, observedAccount: account };
  }

  // JWT payloads are decoded without signature verification: only an already
  // expired numeric exp is used as a conservative signal, never a skew trigger.
  // Opaque/malformed tokens fall back to the stored expiry and 401 handling.
  const storedJwtExp = account.provider === 'openai' ? decodeJwt(creds.accessToken)?.exp : undefined;
  const jwtExpired = typeof storedJwtExp === 'number' && Number.isFinite(storedJwtExp) && storedJwtExp * 1000 <= Date.now();
  const expiring = (!!creds.expiresAt && creds.expiresAt - Date.now() < REFRESH_SKEW_MS) || jwtExpired;
  let current = creds;
  const force = opts.forceRefresh && !internallyRotated && (opts.rejectedToken === undefined || opts.rejectedToken === creds.accessToken);
  const existing = inflight.get(refreshKey(account));
  if (creds.refreshToken && (existing || force || (expiring && !internallyRotated))) {
    const refreshed = await refreshSerialized(account, creds);
    current = refreshed.credentials;
    account = refreshed.account;
  } else if (creds.refreshToken && repo.hasRefreshIntent(account.provider, creds.refreshToken)) {
    throw new RefreshIntentError();
  }
  // A successful refresh may still return an already-expired access token. Persist
  // its rotated refresh token first, but never hand the expired access token out.
  const jwtExp = account.provider === 'openai' ? decodeJwt(current.accessToken)?.exp : undefined;
  if ((current.expiresAt != null && current.expiresAt <= Date.now()) ||
      (typeof jwtExp === 'number' && Number.isFinite(jwtExp) && jwtExp * 1000 <= Date.now())) {
    throw new Error('Access token has expired');
  }
  return { kind: 'oauth', token: current.accessToken, accountId: current.accountId, canRefresh: !!current.refreshToken, observedAccount: account };
}

function refreshSerialized(account: UpstreamAccount, creds: OAuthCredentials): Promise<{ credentials: OAuthCredentials; account: UpstreamAccount }> {
  const key = refreshKey(account);
  const existing = inflight.get(key);
  if (existing) return existing;
  if (stopping) return Promise.reject(new Error('Token refresh unavailable during shutdown'));

  const p = (async () => {
    // 다른 요청이 방금 갱신했을 수 있으므로 DB에서 최신값을 다시 읽는다
    const fresh = repo.findById(account.id);
    if (!fresh || fresh.credentialType !== 'oauth' || !['active', 'quota_exceeded'].includes(fresh.status)) throw new Error('Account credentials changed during refresh');
    const latest = parseStoredCredentials(fresh.credentials);
    if (!latest) throw new Error('Account credentials changed during refresh');
    if (latest.accessToken !== creds.accessToken && latest.expiresAt && latest.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return { credentials: latest, account: fresh };
    }
    const intent = repo.claimRefresh(account.id, fresh.credentials);
    const claimed = parseStoredCredentials(intent.account.credentials);
    if (!claimed) throw new Error('Account credentials changed during refresh');
    try {
      const next = await refreshTokens(intent.account.provider as OAuthProvider, claimed);
      const available = repo.finishRefresh(account.id, intent.credentialVersion, intent.account.credentialRevision, intent.fingerprint, intent.attemptId, JSON.stringify(next), {
        expiresAt: next.expiresAt ?? null,
        hasRefreshToken: !!next.refreshToken,
      });
      if (!available) throw new Error('Account unavailable after refresh');
      logger.info({ account: account.name, expiresAt: next.expiresAt }, 'OAuth token refreshed');
      return { credentials: next, account: available };
    } catch {
      repo.markRefreshError(account.id, intent.credentialVersion, intent.account);
      logger.error({ accountId: account.id }, 'OAuth token refresh failed');
      throw new Error('OAuth token refresh failed; reauthentication may be required');
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}
