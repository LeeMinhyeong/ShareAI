import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { SiwcStore, type SiwcCredential, type SiwcSnapshot } from './siwc-store.js';
import { requestWork, type OwnedDispatch } from '../request-work.js';

const endpoint = 'https://auth.openai.com/api/accounts/oauth/token';
const terminalCodes = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

// Only coalesce callers sharing the exact database connection and generation.
// Other processes remain governed by the durable, never-released claim.
type Flight = { promise: Promise<SiwcSnapshot>; waiters: number };
const inFlight = new WeakMap<object, Map<string, Flight>>();
const providerTimeoutMs = 15000;
const uncertain = () => new Error('SIWC refresh uncertain; reauthorization required');

async function nonblocking<T>(store: SiwcStore, deadline: number, signal: AbortSignal | undefined, action: (store: SiwcStore) => T, stopped?: () => boolean): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline || stopped?.()) throw uncertain();
    try {
      const connection = store.refreshConnection();
      try { return action(connection.store); } finally { connection.close(); }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && (error.code.startsWith('SQLITE_BUSY') || error.code.startsWith('SQLITE_LOCKED')))) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(20, Math.max(0, deadline - Date.now())));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

export async function refreshSiwc(store: SiwcStore, id: string, expected: SiwcSnapshot, fetcher: typeof fetch = fetch, timeoutMs = 15000, signal?: AbortSignal): Promise<SiwcCredential> {
  return (await refreshSiwcSnapshot(store, id, expected, fetcher, timeoutMs, signal)).credential;
}

export async function refreshSiwcSnapshot(store: SiwcStore, id: string, expected: SiwcSnapshot, fetcher: typeof fetch = fetch, timeoutMs = 15000, signal?: AbortSignal): Promise<SiwcSnapshot> {
  const tracked = requestWork.run(() => refreshSiwcSnapshotTracked(store, id, expected, fetcher, timeoutMs, signal));
  if (!tracked) throw uncertain();
  return tracked;
}

async function refreshSiwcSnapshotTracked(store: SiwcStore, id: string, expected: SiwcSnapshot, fetcher: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<SiwcSnapshot> {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw uncertain();
  if (!expected || typeof expected.revision !== 'string' || !expected.credential) throw new Error('SIWC expected credential snapshot required');
  const db = (store as unknown as { db: object }).db;
  let pending = inFlight.get(db);
  if (!pending) { pending = new Map(); inFlight.set(db, pending); }
  const key = JSON.stringify([id, expected.revision, expected.credential]);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let flight = pending.get(key);
  if (!flight) {
    flight = { promise: undefined as unknown as Promise<SiwcSnapshot>, waiters: 1 };
    const current = flight;
    // Reserve a private root before scheduling the flight. Only its explicit
    // capability can register the post-claim operation after admission stops.
    const admitted = requestWork.ownedDispatch(scope => {
      try {
        // Publish the flight before invoking even a synchronous claim.
        const tracked = scope.run(() => Promise.resolve().then(() => performRefresh(store, id, expected, fetcher, current, scope.run)));
        if (!tracked) throw uncertain();
        current.promise = tracked.finally(() => scope.terminal());
        pending!.set(key, current);
      } catch (error) {
        scope.terminal();
        throw error;
      }
    });
    if (!admitted) throw uncertain();
    void current.promise.finally(() => { if (pending!.get(key) === current) pending!.delete(key); }).catch(() => {});
  } else flight.waiters++;
  const currentFlight = flight;
  const waiter = new AbortController();
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      let result: SiwcSnapshot;
      try { result = await currentFlight.promise; }
      catch (error) {
        if (error instanceof Error && (error.message === 'SIWC refresh already attempted or uncertain' || error.message === 'SIWC credentials changed before refresh')) return waitForRefresh(store, id, expected, deadline, waiter.signal, error);
        throw error;
      }
      waiter.signal.throwIfAborted();
      const current = await nonblocking(store, deadline, waiter.signal, s => s.readSnapshot(id));
      if (!current || current.revision !== result.revision || JSON.stringify(current.credential) !== JSON.stringify(result.credential)) throw new Error('SIWC credentials changed during refresh');
      if (Date.parse(result.credential.savedAt) + result.credential.expiresIn * 1000 <= Date.now()) throw new Error('SIWC access token expired');
      return result;
    };
    const waiterWork = requestWork.run(work);
    if (!waiterWork) throw uncertain();
    const result = await Promise.race([waiterWork, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const error = uncertain(); waiter.abort(error); reject(error); }, Math.max(0, deadline - Date.now()));
      onAbort = () => { const error = signal?.reason ?? new Error('Aborted'); waiter.abort(error); reject(error); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
    signal?.throwIfAborted();
    return result;
  } finally { currentFlight.waiters--; if (timer) clearTimeout(timer); if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
}

async function waitForRefresh(store: SiwcStore, id: string, expected: SiwcSnapshot, deadline: number, signal: AbortSignal | undefined, original: Error): Promise<SiwcSnapshot> {
  for (;;) {
    signal?.throwIfAborted();
    const state = await nonblocking(store, deadline, signal, s => s.observeRefresh(id, expected));
    if (state.status === 'complete') {
      if (Date.parse(state.credential.savedAt) + state.credential.expiresIn * 1000 <= Date.now()) throw new Error('SIWC access token expired');
      signal?.throwIfAborted();
      return state.snapshot;
    }
    if (state.status === 'changed') throw new Error('SIWC credentials changed during refresh');
    if (state.status === 'missing') throw original;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('SIWC refresh uncertain; reauthorization required');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(30, remaining));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

// The durable claim is deliberately never released, even on timeout or crash.
async function performRefresh(store: SiwcStore, id: string, expected: SiwcSnapshot, fetcher: typeof fetch, flight: Flight, run: OwnedDispatch['run']): Promise<SiwcSnapshot> {
  const operationDeadline = Date.now() + providerTimeoutMs;
  const intent = await nonblocking(store, operationDeadline, undefined, s => s.claimRefresh(id, expected), () => flight.waiters === 0);
  // There is no exact-claim release API: if the last waiter departed while the
  // claim committed, retain the fence rather than guessing whether it is safe.
  if (flight.waiters === 0) throw uncertain();
  const old = intent.credential;
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, Math.max(0, operationDeadline - Date.now())); });
  try {
    const operation = async () => {
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: old.clientId, refresh_token: old.refreshToken!, resource: 'https://api.openai.com/v1' }), signal: controller.signal });
      const data = await response.json() as Record<string, unknown>;
      if (response.status !== 200) {
        if ((response.status === 400 || response.status === 401) && typeof data.error === 'string' && terminalCodes.has(data.error)) {
          await nonblocking(store, operationDeadline, controller.signal, s => s.invalidateRefresh(id, intent));
          throw new Error('SIWC refresh rejected; reauthorization required');
        }
        if (data.error === 'invalid_client') throw new Error('SIWC invalid client configuration');
        throw new Error('SIWC refresh uncertain');
      }
      if (data.error !== undefined || typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token === old.refreshToken || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' || typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || (data.scope !== undefined && typeof data.scope !== 'string')) throw new Error('SIWC refresh uncertain');
      let idToken = old.idToken;
      if (data.id_token !== undefined) {
        if (typeof data.id_token !== 'string' || !data.id_token) throw new Error('SIWC refresh uncertain');
        const header = decodeProtectedHeader(data.id_token);
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) throw new Error('SIWC refresh uncertain');
        const jwksSignal = AbortSignal.timeout(providerTimeoutMs);
        const jwksResponse = await fetcher('https://auth.openai.com/.well-known/jwks.json', { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: jwksSignal });
        if (jwksResponse.status !== 200) throw new Error('SIWC refresh uncertain');
        const jwks = await jwksResponse.json() as Parameters<typeof createLocalJWKSet>[0];
        jwksSignal.throwIfAborted();
        const { payload } = await jwtVerify(data.id_token, createLocalJWKSet(jwks), { algorithms: ['RS256'], issuer: old.issuer, audience: old.clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
        if (payload.sub !== old.subject || typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 5 || (payload.azp !== undefined && payload.azp !== old.clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== old.clientId)) throw new Error('SIWC refresh uncertain');
        idToken = data.id_token;
      }
      if (data.earliest_refresh_at !== undefined && (typeof data.earliest_refresh_at !== 'number' || !Number.isSafeInteger(data.earliest_refresh_at) || data.earliest_refresh_at < 0)) throw new Error('SIWC refresh uncertain');
      const next: SiwcCredential = { ...old, accessToken: data.access_token, refreshToken: data.refresh_token, idToken, tokenType: 'Bearer', expiresIn: data.expires_in, scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : old.scopes, savedAt: new Date(started).toISOString(), earliestRefreshAt: data.earliest_refresh_at as number | undefined };
      if (next.earliestRefreshAt === undefined) delete next.earliestRefreshAt;
      // A timeout only ends the waiter, not the independently tracked operation.
      // Persist under the original claim/revision fence with a fresh bounded DB
      // budget: the transport signal may already be aborted on a valid late reply.
      const completed = await nonblocking(store, Date.now() + providerTimeoutMs, undefined, s => s.finishRefresh(id, intent, next));
      if (started + next.expiresIn * 1000 <= Date.now()) throw new Error('SIWC access token expired');
      return completed;
    };
    // The timeout may win while transport or verification still has DB capability.
    // Register before invoking it, independently of the flight's race result.
    const inner = run(operation);
    if (!inner) throw uncertain();
    return await Promise.race([inner, deadline]);
  } catch (error) {
    if (error instanceof Error && (error.message === 'SIWC refresh rejected; reauthorization required' || error.message === 'SIWC invalid client configuration' || error.message === 'SIWC access token expired')) throw error;
    throw new Error('SIWC refresh uncertain; reauthorization required');
  } finally { if (timer) clearTimeout(timer); }
}
