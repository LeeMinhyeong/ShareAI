/**
 * 계정별 access token 확보 (만료 임박 시 자동 갱신, 계정별 직렬화)
 */
import type { UpstreamAccount } from '../db/schema.js';
import { AccountRepository, RefreshIntentError } from '../db/repositories/accounts.js';
import { withAsyncWriter } from '../db/async-writer.js';
import { logger } from '../utils/logger.js';
import { decodeJwt, parseStoredCredentials, refreshTokens, type OAuthCredentials, type OAuthProvider } from './oauth.js';

const repo = new AccountRepository();
type Flight = { promise: Promise<{ credentials: OAuthCredentials; account: UpstreamAccount }>; waiters: number; cancel: AbortController; started: boolean };
const inflight = new Map<string, Flight>();
const refreshKey = (account: UpstreamAccount) => JSON.stringify([account.id, account.credentialRevision, account.credentials]);
let stopping = false;

// Block new exchanges before taking the snapshot; existing exchanges must persist
// their rotated token before the database is closed.
export async function drainTokenRefreshes(): Promise<void> {
  stopping = true;
  await Promise.allSettled([...inflight.values()].map(f => f.promise));
}
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface ResolvedAuth {
  kind: 'oauth' | 'api_key';
  token: string;
  accountId?: string | null; // ChatGPT workspace id
  canRefresh: boolean;
  observedAccount: UpstreamAccount;
  refreshConsidered?: boolean;
}

export async function resolveAuth(account: UpstreamAccount, opts: { forceRefresh?: boolean; rejectedToken?: string; signal?: AbortSignal } = {}): Promise<ResolvedAuth> {
  opts.signal?.throwIfAborted();
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
  let refreshConsidered = false;
  if (creds.refreshToken && (existing || force || (expiring && !internallyRotated))) {
    refreshConsidered = true;
    const refreshed = await refreshSerialized(account, creds, opts.signal);
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
  return { kind: 'oauth', token: current.accessToken, accountId: current.accountId, canRefresh: !!current.refreshToken, observedAccount: account, refreshConsidered };
}

function refreshSerialized(account: UpstreamAccount, creds: OAuthCredentials, signal?: AbortSignal): Promise<{ credentials: OAuthCredentials; account: UpstreamAccount }> {
  signal?.throwIfAborted();
  const key = refreshKey(account);
  let flight = inflight.get(key);
  if (stopping) return Promise.reject(new Error('Token refresh unavailable during shutdown'));
  if (!flight) {
  const f: Flight = { waiters: 0, cancel: new AbortController(), started: false, promise: undefined! };
  flight = f;
  f.promise = (async () => {
    await Promise.resolve();
    f.cancel.signal.throwIfAborted();
    // 다른 요청이 방금 갱신했을 수 있으므로 DB에서 최신값을 다시 읽는다
    const fresh = repo.findById(account.id);
    if (!fresh || fresh.credentialType !== 'oauth' || !['active', 'quota_exceeded'].includes(fresh.status)) throw new Error('Account credentials changed during refresh');
    const latest = parseStoredCredentials(fresh.credentials);
    if (!latest) throw new Error('Account credentials changed during refresh');
    if (latest.accessToken !== creds.accessToken && latest.expiresAt && latest.expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return { credentials: latest, account: fresh };
    }
    const intent = await withAsyncWriter(db => {
      f.cancel.signal.throwIfAborted();
      return repo.claimRefresh(account.id, fresh.credentials, db, fresh.credentialRevision);
    }, {signal:f.cancel.signal});
    if (f.cancel.signal.aborted) {
      // The claim returned after a confirmed commit, and provider invocation has
      // not started. Release only this exact claim and credential generation.
      // If cleanup fails before commit the fence remains; an uncertain cleanup
      // commit may have removed it, but the provider has definitely not run.
      try {
        await withAsyncWriter(db => repo.releaseUnusedRefresh(account.id, intent.credentialVersion, intent.account.credentialRevision, intent.fingerprint, intent.attemptId, db));
      } catch {
        // Do not expose credentials or assume whether cleanup committed.
        logger.error({ accountId: account.id }, 'Failed to release unused OAuth refresh intent; token may remain fenced');
      }
      f.cancel.signal.throwIfAborted();
    }
    const claimed = parseStoredCredentials(intent.account.credentials);
    if (!claimed) throw new Error('Account credentials changed during refresh');
    try {
      f.started = true;
      const next = await refreshTokens(intent.account.provider as OAuthProvider, claimed);
      const available = await withAsyncWriter(db => repo.finishRefresh(account.id, intent.credentialVersion, intent.account.credentialRevision, intent.fingerprint, intent.attemptId, JSON.stringify(next), {
        expiresAt: next.expiresAt ?? null,
        hasRefreshToken: !!next.refreshToken,
      }, db));
      if (!available) throw new Error('Account unavailable after refresh');
      logger.info({ account: account.name, expiresAt: next.expiresAt }, 'OAuth token refreshed');
      return { credentials: next, account: available };
    } catch {
      try { await withAsyncWriter(db => repo.markRefreshError(account.id, intent.credentialVersion, intent.account, db)); } catch { /* intent remains a permanent fence */ }
      logger.error({ accountId: account.id }, 'OAuth token refresh failed');
      throw new Error('OAuth token refresh failed; reauthentication may be required');
    }
  })().finally(() => { if (inflight.get(key) === f) inflight.delete(key); });
  inflight.set(key, f);
  }
  const active = flight;
  active.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (--active.waiters === 0) active.cancel.abort();
      fn();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    signal?.addEventListener('abort', onAbort, {once:true});
    if (signal?.aborted) onAbort();
    active.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
