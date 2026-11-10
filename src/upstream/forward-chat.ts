import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { accountPool } from '../account-pool/manager.js';
import { UsageLogRepository } from '../db/repositories/usage-logs.js';
import { RefreshIntentError } from '../db/repositories/accounts.js';
import { logger } from '../utils/logger.js';
import { resolveAuth } from './tokens.js';
import { infer, UpstreamError, isSiwcStream429 } from './inference.js';
import { invokeAccountAttempt, settleAccountAttempt, AccountAttemptOpen, AccountQuotaUnavailable, AccountCooldownBeforeDispatch, type AccountAttempt } from './account-quota.js';
import { getDb } from '../db/client.js';
import { withAsyncWriter } from '../db/async-writer.js';
import { arm429V2, assert429V2Schema } from '../db/account-429-v2-store.js';
import { CredentialVault } from '../utils/encryption.js';
import { SiwcStore, type SiwcSnapshot } from './siwc-store.js';
import type Database from 'better-sqlite3';
import { refreshSiwcSnapshot } from './siwc-refresh.js';
import { SettingsRepository, STRATEGIES } from '../db/repositories/settings.js';

import { ordinary429Deadline, recovery429Duration as recovery429DurationAt } from './ordinary-429-deadline.js';
export { ordinary429Deadline } from './ordinary-429-deadline.js';

// Persisted restrictions use the stricter recovery gate (ADR 0008); see
// ordinary-429-deadline.ts. Only the wall-clock sample lives here.
function recovery429Duration(hint?: string, serverDate?: string): number | null {
  return recovery429DurationAt(Date.now(), hint, serverDate);
}

// Wait before an account whose dispatched attempt the router aborted returns (ADR 0008).
export const ROUTER_ABORT_RESTRICTION_MS = 60_000;

const usageRepo = new UsageLogRepository();
const settingsRepo = new SettingsRepository();
export function siwcAccess(db: Database.Database, userId: string, accountId: string) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get() && db.prepare(`SELECT 1 FROM siwc_accounts a JOIN siwc_access_policy p ON p.account_id=a.id
    JOIN users u ON u.id=? AND u.enabled=1
    WHERE a.id=? AND p.enabled=1 AND (p.scope='all' OR (p.scope='selected' AND EXISTS
      (SELECT 1 FROM siwc_access_users g WHERE g.account_id=a.id AND g.user_id=u.id)))`).get(userId, accountId);
}
/** Synchronous production SIWC invocation checks; caller must hold the writer through network initiation. */
export function assertSiwcDispatchGate(db: Database.Database, userId: string, accountId: string, expected: SiwcSnapshot, signal: AbortSignal, deferLocalCooldown = false): void {
  if (!db.inTransaction) throw new Error('SIWC dispatch gate requires writer transaction');
  if (!siwcAccess(db, userId, accountId)) throw new UpstreamError(404, 'SIWC account not found');
  const current = new SiwcStore(db, new CredentialVault(), {initialize:false}).readSnapshot(accountId);
  if (!current || current.revision !== expected.revision || JSON.stringify(current.credential) !== JSON.stringify(expected.credential)
    || !current.credential.scopes.includes('chatgpt.tokens.use.direct')
    || Date.parse(current.credential.savedAt) + current.credential.expiresIn * 1000 <= Date.now()) throw new UpstreamError(503, 'SIWC account requires sign-in');
  if (!deferLocalCooldown && accountPool.siwcCooling(accountId, current.revision)) throw new UpstreamError(503, 'SIWC account temporarily unavailable');
  signal.throwIfAborted();
}
class SiwcAdmissionRace extends UpstreamError {
  constructor() { super(503, 'SIWC account temporarily unavailable'); }
}
function siwcRestricted(db: Database.Database, id: string): boolean {
  assert429V2Schema(db);
  return !!db.prepare("SELECT 1 FROM main.account_429_v2_restrictions WHERE kind='siwc' AND account_id=?").get(id);
}
async function settleSiwc(attempt: {accountId:string; attemptId:string}, restriction?: {hint?:string; date?:string; durationMs?:number}): Promise<void> {
  await withAsyncWriter(db => {
    if (!db.prepare('SELECT 1 FROM main.siwc_account_attempts WHERE account_id=? AND attempt_id=?').get(attempt.accountId, attempt.attemptId)) throw new Error('SIWC attempt ownership lost');
    if (restriction) {
      arm429V2(db, 'siwc', attempt.accountId, restriction.durationMs ?? recovery429Duration(restriction.hint, restriction.date));
    }
    if (db.prepare('DELETE FROM main.siwc_account_attempts WHERE account_id=? AND attempt_id=?').run(attempt.accountId, attempt.attemptId).changes !== 1) throw new Error('SIWC attempt ownership lost');
  });
}
// ADR 0016 item 3: no whole-request limit. Each dispatch must yield response
// headers within firstResponseMs; afterwards the request is abandoned only when
// neither a provider body chunk (SSE comments included) nor a completed client
// write was observed for idleMs. Mutable only as a test seam; operator
// configuration is backlog.
export const INFERENCE_TIMEOUTS = {firstResponseMs: 60_000, idleMs: 300_000};
export async function forwardChat(req: Request, res: Response) {
  const user = req.user!; const started = process.hrtime.bigint(); const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  if (res.destroyed && !res.writableEnded) controller.abort();
  let account: Awaited<ReturnType<typeof accountPool.selectAccount>> = null;
  let usedToken: string | undefined;
  let observedAccount: Awaited<ReturnType<typeof accountPool.selectAccount>> = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => { if (watchdog) { clearTimeout(watchdog); watchdog = undefined; } };
  // Which router limit fired, for diagnostics only; settlement keys on signal.aborted.
  let timedOut: 'first-response' | 'idle' | undefined;
  const arm = (kind: 'first-response' | 'idle') => {
    disarm();
    const ms = kind === 'idle' ? INFERENCE_TIMEOUTS.idleMs : INFERENCE_TIMEOUTS.firstResponseMs;
    // Clearing the handle first keeps a later touch() from rescheduling a fired timer.
    watchdog = setTimeout(() => { watchdog = undefined; timedOut = kind; controller.abort(); }, ms);
    watchdog.unref();
  };
  // Progress re-arms the current (idle) limit with its original duration.
  const touch = () => { watchdog?.refresh(); };
  const observeBody = (response: globalThis.Response) => {
    arm('idle');
    if (!response.body) return response;
    let body: ReadableStream<Uint8Array>;
    try { body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({transform(chunk, sink) { touch(); sink.enqueue(chunk); }})); }
    catch (error) { try { void response.body.cancel().catch(() => {}); } catch { /* already locked */ } throw error; }
    // url/redirected are not carried over; inference must not rely on them.
    return new globalThis.Response(body, {status:response.status, statusText:response.statusText, headers:response.headers});
  };
  let siwcSelected: string | undefined;
  let siwcDispatched = false;
  let siwcDispatchedRevision: string | undefined;
  let siwcFailureMarker: ReturnType<typeof accountPool.siwcFailureMarker>;
  let logModel = ''; let logProvider = ''; let logStatus: number | null = null; let logSuccess = false;
  let completedAtMs: number | undefined;
  let completedLatencyMs: number | undefined;
  let ordinaryDispatched = false;
  const sampleCompletion = () => {
    completedAtMs = Date.now();
    const nanos = process.hrtime.bigint() - started;
    const elapsed = nanos / 1000000n;
    completedLatencyMs = nanos >= 0n && elapsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(elapsed) : undefined;
  };
  let completedAborted = false;
  let usage: {input:number; output:number} | undefined;
  let ordinaryAttempt: AccountAttempt | undefined;
  // Dispatch is tracked per attempt handle: a 401 refresh retry opens a new one.
  let ordinaryDispatchedAttempt: AccountAttempt | undefined;
  let siwcDispatchedAttempt: {accountId:string; attemptId:string} | undefined;
  // Set once a provider terminal (HTTP status, validated stream end or SSE 429)
  // was observed for the current dispatch; reset when a new attempt (e.g. the
  // 401 refresh retry) is dispatched. A later abort must not reinterpret it.
  let terminalObserved = false;
  let siwcAttempt: {accountId:string; attemptId:string} | undefined;
  // This request-local token can only be emitted by the committed read-only
  // exhaustion callback, never by a provider or a failed writer transaction.
  const committedQuotaExhaustion = Symbol('committed quota exhaustion');
  const committedConflict = Symbol('committed admission conflict');
  let committedConflictError: AccountAttemptOpen | AccountCooldownBeforeDispatch | undefined;
  const invokeOrdinary = async (observed: NonNullable<typeof account>, start: () => Promise<globalThis.Response>, allowReselectSignal = true) => {
    const response = await invokeAccountAttempt(observed, controller.signal, () => { ordinaryDispatched = true; ordinaryDispatchedAttempt = ordinaryAttempt; terminalObserved = false; arm('first-response'); return start(); }, handle => { ordinaryAttempt = handle; }, () => {
      if (ordinaryDispatched || !allowReselectSignal) throw new AccountQuotaUnavailable();
      throw committedQuotaExhaustion;
    }, error => {
      if (ordinaryDispatched || !allowReselectSignal) throw error;
      committedConflictError = error;
      throw committedConflict;
    });
    if (!response.ok) {
      terminalObserved = true;
      const handle = ordinaryAttempt!;
      try {
        const duration = response.status === 429
          ? recovery429Duration(response.headers.get('retry-after') ?? undefined, response.headers.get('date') ?? undefined)
          : response.status >= 500 && response.status <= 599
            ? accountPool.shared5xxBackoffMs('upstream', handle.accountId, observed.stateRevision)
            : undefined;
        await settleAccountAttempt(handle, duration === undefined ? undefined : db => {
          arm429V2(db, 'upstream', handle.accountId, duration);
        });
        ordinaryAttempt = undefined;
      } catch {
        try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
        throw new UpstreamError(503, 'Unable to settle upstream outcome');
      }
    }
    if (response.ok) return observeBody(response);
    // Bound the bookkeeping (and a 401 refresh) until a new dispatch re-arms.
    arm('first-response');
    return response;
  };
  try {
    const {model, messages, stream = false, router_options, temperature, max_tokens} = req.body ?? {};
    const allowed = new Set(['model','messages','stream','router_options','temperature','max_tokens']);
    if (typeof model !== 'string' || !model || !Array.isArray(messages) || typeof stream !== 'boolean' || Object.keys(req.body ?? {}).some(k => !allowed.has(k))) throw new UpstreamError(400, 'Invalid or unsupported chat request fields');
    if ((temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature))) || (max_tokens !== undefined && (!Number.isInteger(max_tokens) || max_tokens <= 0))) throw new UpstreamError(400, 'Invalid generation options');
    if (router_options !== undefined && (router_options === null || typeof router_options !== 'object' || Array.isArray(router_options) || Object.keys(router_options).some(k => k !== 'strategy' && k !== 'siwc_account_id'))) throw new UpstreamError(400, 'Invalid routing options');
    const provider = model.includes('claude') ? 'anthropic' : /^(gpt|o1|o3|o4|codex)/.test(model) ? 'openai' : null;
    if (!provider) throw new UpstreamError(400, 'Unsupported provider');
    logModel = model; logProvider = provider;
    const excludedUpstream = new Set<string>();
    const excludedSiwc = new Set<string>();
    const canReselect = () => excludedUpstream.size + excludedSiwc.size < 15;
    let events;
    const request = {model, messages, temperature, max_tokens};
    selection: while (true) {
    let siwcId = router_options?.siwc_account_id;
    if (siwcId === undefined) {
      const strategy = router_options?.strategy === undefined ? settingsRepo.getStrategy(provider) : router_options.strategy;
      if (!STRATEGIES.includes(strategy)) throw new UpstreamError(400, 'Invalid selection strategy');
      const candidate = await accountPool.selectCandidate(user.id, model, provider, strategy, {excludeUpstream:excludedUpstream, excludeSiwc:excludedSiwc, credentialTypes:['oauth','api_key'], supportsGenerationOptions:temperature !== undefined || max_tokens !== undefined});
      if (!candidate) throw new UpstreamError(503, 'No supported upstream account available');
      if (candidate.kind === 'siwc') siwcId = candidate.id;
      else account = candidate.account;
    }
    if (siwcId !== undefined) {
      if (typeof siwcId !== 'string' || !siwcId.trim() || provider !== 'openai' || (router_options?.siwc_account_id !== undefined && Object.keys(router_options).some(k => k !== 'siwc_account_id'))) throw new UpstreamError(400, 'Invalid SIWC account selection');
      const db = getDb();
      // Missing policies, disabled accounts, and absent grants all fail closed.
      const canAccess = (connection = db) => siwcAccess(connection, user.id, siwcId);
      if (!canAccess()) throw new UpstreamError(404, 'SIWC account not found');
      siwcSelected = siwcId;
      const store = new SiwcStore(db, new CredentialVault(), { initialize: false });
      let snapshot;
      let refreshInvoked = false;
      try { snapshot = store.readSnapshot(siwcId); } catch { throw new UpstreamError(503, 'Invalid SIWC credentials'); }
      if (!snapshot) throw new UpstreamError(503, 'SIWC account requires sign-in');
      if (!snapshot.credential.scopes.includes('chatgpt.tokens.use.direct')) throw new UpstreamError(403, 'ChatGPT plan usage is not enabled');

      if (Date.parse(snapshot.credential.savedAt) + snapshot.credential.expiresIn * 1000 <= Date.now()) {
        // Never refresh a locally cooling credential merely to enable reselection.
        if (accountPool.siwcCooling(siwcId, snapshot.revision)) throw new UpstreamError(503, 'SIWC account temporarily unavailable');
        // Refresh can itself contact the provider; fail closed on absent or
        // unsafe v2 state under the real writer before starting that network I/O.
        await withAsyncWriter(writer => {
          if (!siwcAccess(writer, user.id, siwcId)) throw new UpstreamError(404, 'SIWC account not found');
          if (siwcRestricted(writer, siwcId)) throw new UpstreamError(503, 'SIWC account temporarily unavailable');
        }, {signal:controller.signal});
        if (!snapshot.credential.refreshToken || !snapshot.credential.scopes.includes('offline_access')) throw new UpstreamError(503, 'SIWC account requires sign-in');
        try {
          refreshInvoked = true;
          snapshot = await refreshSiwcSnapshot(store, siwcId, snapshot, fetch, 15000, controller.signal);
        } catch { throw new UpstreamError(503, 'SIWC refresh unavailable; retry later or sign in again'); }
        if (!snapshot || !snapshot.credential.scopes.includes('chatgpt.tokens.use.direct')) throw new UpstreamError(403, 'ChatGPT plan usage is not enabled');
      }
      // A refresh can yield while an administrator revokes access.
      if (!canAccess()) throw new UpstreamError(404, 'SIWC account not found');
      // Bounds admission; dispatch re-arms the first-response limit.
      arm('first-response');
      const expected = snapshot;
      try { events = await infer('openai', {kind:'siwc', token:expected.credential.accessToken}, request, undefined, controller.signal, async start => {
        let pending: Promise<globalThis.Response> | undefined;
        let started = false;
        try {
          const attempt = {accountId:siwcId, attemptId:randomUUID()};
          const admitted = await withAsyncWriter(writer => {
            assertSiwcDispatchGate(writer, user.id, siwcId, expected, controller.signal, true);
            if (accountPool.siwcCooling(siwcId, expected.revision) || siwcRestricted(writer, siwcId) || writer.prepare('SELECT 1 FROM main.siwc_account_attempts WHERE account_id=?').get(siwcId)) return false;
            writer.prepare('INSERT INTO main.siwc_account_attempts(account_id,attempt_id) VALUES (?,?)').run(siwcId, attempt.attemptId);
            return true;
          }, {signal:controller.signal});
          if (!admitted) throw new SiwcAdmissionRace();
          siwcAttempt = attempt;
          const result = await withAsyncWriter(writer => {
            assertSiwcDispatchGate(writer, user.id, siwcId, expected, controller.signal);
            if (siwcRestricted(writer, siwcId) || !writer.prepare('SELECT 1 FROM main.siwc_account_attempts WHERE account_id=? AND attempt_id=?').get(siwcId, attempt.attemptId)) throw new UpstreamError(503, 'SIWC account temporarily unavailable');
            siwcFailureMarker = accountPool.siwcFailureMarker(siwcId);
            started = true;
            siwcDispatched = true;
            siwcDispatchedAttempt = attempt;
            terminalObserved = false;
            siwcDispatchedRevision = expected.revision;
            arm('first-response');
            pending = start();
            if (!(pending instanceof Promise)) throw new Error('Invalid fetch promise');
            return {pending};
          }, {signal:controller.signal});
          let response: globalThis.Response;
          try { response = await result.pending; }
          catch { throw new UpstreamError(502, 'SIWC upstream request failed'); }
          if (!(response instanceof globalThis.Response)) throw new UpstreamError(502, 'Invalid upstream response');
          if (response.ok) response = observeBody(response);
          else arm('first-response');
          if (!response.ok) {
            terminalObserved = true;
            try {
              const restriction = response.status === 429
                ? {hint:response.headers.get('retry-after') ?? undefined, date:response.headers.get('date') ?? undefined}
                : response.status >= 500 && response.status <= 599
                  ? {durationMs:accountPool.shared5xxBackoffMs('siwc', attempt.accountId, expected.revision)}
                  : undefined;
              await settleSiwc(attempt, restriction);
              siwcAttempt = undefined;
            } catch {
              try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
              throw new UpstreamError(503, 'Unable to settle SIWC outcome');
            }
          }
          return response;
        } catch (error) {
          if (pending instanceof Promise) void pending.catch(() => {});
          // Only a confirmed committed admission can be released, and only before
          // entering start(). Cleanup is independent of the cancelled request.
          if (!started && siwcAttempt) {
            try { await settleSiwc(siwcAttempt); siwcAttempt = undefined; }
            catch { /* Unknown cleanup outcome: retain the fence and never retry. */ }
          }
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError(503, 'SIWC inference unavailable');
        }
      }); } catch (error) {
        if (error instanceof SiwcAdmissionRace && !refreshInvoked && router_options?.siwc_account_id === undefined && canReselect()) {
          controller.signal.throwIfAborted(); disarm();
          excludedSiwc.add(siwcId); siwcSelected = undefined; continue selection;
        }
        throw error;
      }
    } else {
    if (!account) throw new UpstreamError(503, 'No supported upstream account available');
    const auth = await resolveAuth(account, {signal:controller.signal});
    observedAccount = auth.observedAccount;
    if (observedAccount.credentialType !== auth.kind) throw new UpstreamError(400, 'Invalid stored credentials');
    usedToken = auth.token;
    // Bounds admission; dispatch re-arms the first-response limit.
    arm('first-response');
    try { events = await infer(provider, auth, request, undefined, controller.signal, start => invokeOrdinary(auth.observedAccount, start)); }
    catch (error) {
      if ((error === committedConflict || error === committedQuotaExhaustion) && !ordinaryDispatched && !auth.refreshConsidered && auth.observedAccount.stateRevision === account.stateRevision && auth.observedAccount.credentialRevision === account.credentialRevision && canReselect()) {
        controller.signal.throwIfAborted();
        disarm();
        excludedUpstream.add(account.id);
        account = null; observedAccount = null; usedToken = undefined;
        continue selection;
      }
      if (error === committedConflict) throw committedConflictError!;
      if (error === committedQuotaExhaustion) throw new AccountQuotaUnavailable();
      if (!(error instanceof UpstreamError) || error.status !== 401 || !auth.canRefresh) throw error;
      controller.signal.throwIfAborted();
      const refreshed = await resolveAuth(auth.observedAccount, {forceRefresh:true, rejectedToken:auth.token, signal:controller.signal});
      observedAccount = refreshed.observedAccount;
      if (refreshed.kind !== 'oauth') throw new UpstreamError(400, 'Invalid refreshed credentials');
      usedToken = refreshed.token;
      events = await infer(provider, refreshed, request, undefined, controller.signal, start => invokeOrdinary(refreshed.observedAccount, start, false));
    }
    }
    break;
    }
    const id = 'chatcmpl-' + randomUUID(), created = Math.floor(Date.now()/1000);
    let content = '', finish = 'stop';
    if (stream) {
      res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
      const write = async (delta: object, reason: string | null = null) => {
        const data = {id, object:'chat.completion.chunk', created, model, choices:[{index:0,delta,finish_reason:reason}]};
        if (!res.write(`data: ${JSON.stringify(data)}\n\n`)) await once(res,'drain', {signal:controller.signal});
        touch();
      };
      await write({role:'assistant'});
      for await (const e of events) { if (e.text !== undefined) await write({content:e.text}); if (e.finish) finish = e.finish; if (e.usage) usage = e.usage; }
      terminalObserved = true;
      if (ordinaryAttempt) { await settleAccountAttempt(ordinaryAttempt); ordinaryAttempt = undefined; }
      if (siwcAttempt) { await settleSiwc(siwcAttempt); siwcAttempt = undefined; }
      controller.signal.throwIfAborted(); sampleCompletion();
      await write({}, finish); res.end('data: [DONE]\n\n');
    } else {
      for await (const e of events) { if (e.text !== undefined) content += e.text; if (e.finish) finish = e.finish; if (e.usage) usage = e.usage; }
      terminalObserved = true;
      if (ordinaryAttempt) { await settleAccountAttempt(ordinaryAttempt); ordinaryAttempt = undefined; }
      if (siwcAttempt) { await settleSiwc(siwcAttempt); siwcAttempt = undefined; }
      controller.signal.throwIfAborted(); sampleCompletion();
      res.json({id, object:'chat.completion', created, model, choices:[{index:0,message:{role:'assistant',content},finish_reason:finish}], ...(usage ? {usage:{prompt_tokens:usage.input, completion_tokens:usage.output,total_tokens:usage.input+usage.output}} : {})});
    }
    logSuccess = true; logStatus = 200;
    if (siwcSelected && siwcDispatchedRevision !== undefined && !controller.signal.aborted) {
      try { accountPool.recordSiwcSuccess(siwcSelected, siwcDispatchedRevision, siwcFailureMarker); }
      catch (error) { logger.error({error}, 'Failed to record SIWC success'); }
    }
    if (account) {
      try { await accountPool.recordSuccessAsync(account.id, true, observedAccount ?? account, usedToken); }
      catch (error) { logger.error({error}, 'Failed to record upstream success'); }
    }
    if (account && !controller.signal.aborted) {
      // Preserve the parser's unknown pair; legacy zero provenance is separate.
      const completion = completedAtMs!;
      try { await withAsyncWriter(db => usageRepo.create({userId:user.id, upstreamAccountId:account!.id, model, provider, inputTokens:usage?.input ?? null, outputTokens:usage?.output ?? null, success:true, completedAtMs:completion, latencyMs:completedLatencyMs!}, db)); }
      catch (error) { logger.error({error}, 'Failed to log usage'); }
    }
  } catch (error: any) {
    // Snapshot before any await: a provider failure reaches this point through
    // microtasks only, so a later client close or timer cannot be misattributed.
    const routerAborted = controller.signal.aborted;
    if (siwcAttempt && isSiwcStream429(error)) {
      terminalObserved = true;
      try { await settleSiwc(siwcAttempt, {}); siwcAttempt = undefined; }
      catch { error = new UpstreamError(503, 'Unable to settle SIWC outcome'); }
    }
    // ADR 0008 (2026-11-09): only this request's controller aborts — on client
    // disconnect or the router's own inference timer. A dispatched attempt the
    // router itself abandoned becomes a finite shared restriction in the same
    // transaction that deletes its exact OPEN, so the account recovers through
    // monotonic expiry. Undispatched claims keep their exact release; all other
    // uncertain outcomes keep the OPEN, as does an uncertain conversion.
    if (routerAborted && !terminalObserved) {
      if (ordinaryAttempt && ordinaryDispatchedAttempt === ordinaryAttempt) {
        const handle = ordinaryAttempt;
        try { await settleAccountAttempt(handle, db => arm429V2(db, 'upstream', handle.accountId, ROUTER_ABORT_RESTRICTION_MS)); ordinaryAttempt = undefined; }
        catch { /* Unknown conversion outcome: retain the OPEN. */ }
      }
      if (siwcAttempt && siwcDispatchedAttempt === siwcAttempt) {
        try { await settleSiwc(siwcAttempt, {durationMs:ROUTER_ABORT_RESTRICTION_MS}); siwcAttempt = undefined; }
        catch { /* Unknown conversion outcome: retain the OPEN. */ }
      }
    }
    sampleCompletion();
    completedAborted = controller.signal.aborted;
    let status = error instanceof RefreshIntentError ? 503 : error instanceof UpstreamError ? error.status : 502;

    const validErrorStatus = Number.isInteger(status) && status >= 400 && status <= 599;
    logStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const shouldRecordFailure = account && ordinaryDispatched && !controller.signal.aborted && (status === 401 || status === 403 || status === 429 || !validErrorStatus || status >= 500) && !(error instanceof RefreshIntentError) && !(error instanceof AccountQuotaUnavailable);
    if (siwcSelected && siwcDispatchedRevision !== undefined && !controller.signal.aborted && (!validErrorStatus || status === 429 || status >= 500)) {
      try { accountPool.recordSiwcFailure(siwcSelected, siwcDispatchedRevision); }
      catch (recordError) { logger.error({error:recordError}, 'Failed to record SIWC failure'); }
    }
    logger.error({status:logStatus, userId:user.id, ...(timedOut ? {routerTimeout:timedOut} : {})}, 'Inference request failed');
    if (!res.headersSent && status === 429 && error instanceof UpstreamError && error.headers?.['retry-after'] !== undefined) {
      const now = Date.now();
      const deadline = ordinary429Deadline(now, error.headers['retry-after'], error.headers.date);
      if (deadline !== Number.MAX_SAFE_INTEGER) res.setHeader('Retry-After', String(Math.ceil((deadline - now) / 1000)));
    }
    if (res.headersSent && !controller.signal.aborted && res.getHeader('Content-Type') === 'text/event-stream') res.end(`data: ${JSON.stringify({error:{type:'upstream_error',message:error instanceof UpstreamError ? error.message : 'Upstream request failed'}})}\n\n`);
    else if (res.headersSent) res.destroy();
    else res.status(validErrorStatus ? status : 502).json({error:{type:status === 400 ? 'invalid_request_error' : 'upstream_error',message:error instanceof RefreshIntentError ? 'Token refresh is in progress or its outcome is uncertain; retry later or reauthenticate' : error instanceof UpstreamError ? error.message : 'Upstream request failed'}});
    if (shouldRecordFailure && account) {
      try { await accountPool.recordFailureAsync(account.id, {status, message:`Upstream request failed (${status})`}, observedAccount ?? account, usedToken, controller.signal); }
      catch (recordError) { logger.error({error:recordError}, 'Failed to record upstream failure'); }
    }
    if (ordinaryDispatched && account) {
      try { await withAsyncWriter(db => usageRepo.create({userId:user.id, upstreamAccountId:account!.id, model:logModel, provider:logProvider, inputTokens:usage?.input ?? null, outputTokens:usage?.output ?? null, success:false, completedAtMs:completedAtMs, latencyMs:completedLatencyMs!}, db)); }
      catch (recordError) { logger.error({error:recordError}, 'Failed to log upstream usage'); }
    }
  } finally {
    disarm();
    // Usage history represents invoked inference, not pre-dispatch rejections;
    // those remain absent from provider diagnostics even though user quota was reserved.
    if (siwcSelected && siwcDispatched) {
      const completion = completedAtMs ?? Date.now();
      const latencyMs = completedLatencyMs;
      try {
        if (!Number.isSafeInteger(completion) || Math.abs(completion) > 8640000000000000) throw new RangeError('Invalid usage completion time');
        if (!Number.isSafeInteger(latencyMs) || latencyMs! < 0) throw new RangeError('Invalid usage latency');
        const timestamp = new Date(completion).toISOString();
        await withAsyncWriter(db => db.prepare(`INSERT INTO siwc_usage_logs (id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,status,latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),user.id,siwcSelected,timestamp,logModel,logProvider,usage?.input ?? null,usage?.output ?? null,logSuccess ? 1 : 0,completedAborted ? 1 : 0,logStatus,latencyMs));
      }
      catch (error) { logger.error({error}, 'Failed to log SIWC usage'); }
    }
  }
}
