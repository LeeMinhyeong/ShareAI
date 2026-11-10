import { withAsyncWriter } from '../db/async-writer.js';
import { assert429V2Schema } from '../db/account-429-v2-store.js';
import { createOpenAttemptCallback } from '../db/durable-ledger-foundation.js';
import type { UpstreamAccount } from '../db/schema.js';
import { UpstreamError } from './inference.js';
import { decodeJwt, parseStoredCredentials } from './oauth.js';
import { refreshFingerprint } from '../db/repositories/accounts.js';
import { randomUUID } from 'crypto';

export class AccountQuotaUnavailable extends UpstreamError {
  constructor() { super(503, 'Upstream account quota or state unavailable'); }
}
// Public diagnostic type; it does not prove retry eligibility or provenance.
export class AccountQuotaExhausted extends AccountQuotaUnavailable {}
export class AccountAttemptOpen extends AccountQuotaUnavailable {}
// Public diagnostic type; it does not prove retry eligibility or provenance.
export class AccountCooldownBeforeDispatch extends AccountQuotaUnavailable {}
export type AccountAttempt = {accountId:string; attemptId:string};

/** Settle only a known outcome. A missing owner rolls the whole transaction back. */
export async function settleAccountAttempt(attempt: AccountAttempt, beforeClose?: (db: import('better-sqlite3').Database) => void): Promise<void> {
  await withAsyncWriter(db => {
    if (!db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=? AND attempt_id=?').get(attempt.accountId, attempt.attemptId)) throw new Error('Attempt ownership lost');
    beforeClose?.(db);
    if (db.prepare('DELETE FROM main.ordinary_account_attempts WHERE account_id=? AND attempt_id=?').run(attempt.accountId, attempt.attemptId).changes !== 1) throw new Error('Attempt ownership lost');
  });
}

function quotaOperations(account: UpstreamAccount, signal: AbortSignal) {
  const exhausted = Symbol('confirmed quota exhaustion');
  // Staged integration: legacy settlement does not arm v2; do not deploy alone.
  const cooling = (db: import('better-sqlite3').Database) => {
    assert429V2Schema(db);
    return !!db.prepare('SELECT 1 FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?').get('upstream', account.id);
  };
  const validate = (db: import('better-sqlite3').Database, checkCooldown = true) => {
    const a = db.prepare('SELECT status, state_revision, credential_revision, daily_quota FROM upstream_accounts WHERE id=?').get(account.id) as any;
    if (!a || !['active','quota_exceeded'].includes(a.status) || a.state_revision !== account.stateRevision || a.credential_revision !== account.credentialRevision || !Number.isSafeInteger(a.daily_quota) || a.daily_quota < 0) throw new AccountQuotaUnavailable();
    if (checkCooldown && cooling(db)) throw new AccountQuotaUnavailable();
    return a;
  };
  const validateAuth = (db: import('better-sqlite3').Database) => {
    // Called only after revision validation, under the same writer fence.
    const creds = parseStoredCredentials(account.credentials);
    if (creds) {
      const exp = account.provider === 'openai' ? decodeJwt(creds.accessToken)?.exp : undefined;
      const now = Date.now();
      if ((creds.expiresAt != null && creds.expiresAt <= now) ||
          (typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 <= now) ||
          (creds.refreshToken && db.prepare('SELECT 1 FROM oauth_refresh_intents WHERE token_fingerprint=?').get(refreshFingerprint(account.provider, creds.refreshToken)))) throw new AccountQuotaUnavailable();
    }
  };
  const reserve = (db: import('better-sqlite3').Database): string | typeof exhausted => {
    const a = validate(db);
    validateAuth(db);
    signal.throwIfAborted();
    const day = new Date().toISOString().slice(0, 10);
    let row = db.prepare('SELECT day,used,legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(account.id) as any;
    if (row && (typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || Number.isNaN(Date.parse(`${row.day}T00:00:00Z`)) || new Date(`${row.day}T00:00:00Z`).toISOString().slice(0,10) !== row.day || row.day > day || !Number.isSafeInteger(row.used) || row.used < 0 || ![0,1].includes(row.legacy_ambiguous))) throw new AccountQuotaUnavailable();
    if (!row || row.day < day) {
      db.prepare(`INSERT INTO account_daily_reservations(account_id,day,used,legacy_ambiguous) VALUES(?,?,0,0)
        ON CONFLICT(account_id) DO UPDATE SET day=excluded.day,used=0,legacy_ambiguous=0`).run(account.id,day);
      row = {day, used:0, legacy_ambiguous:0};
    }
    if (a.daily_quota > 0 && !row.legacy_ambiguous && row.day === day && row.used >= a.daily_quota) return exhausted;
    if (row.used >= Number.MAX_SAFE_INTEGER || (a.daily_quota > 0 && row.legacy_ambiguous)) throw new AccountQuotaUnavailable();
    db.prepare('UPDATE account_daily_reservations SET used=used+1 WHERE account_id=?').run(account.id);
    return day;
  };
  return {validate, validateAuth, reserve, cooling, exhausted};
}

/** Experimental callback only: no dispatch and no durability result. Errors must
 * escape the outer writer, which must roll back. Unknown commit means no start. */
export function createLedgerQuotaReservation(account: UpstreamAccount, signal: AbortSignal, id: string): (db: import('better-sqlite3').Database) => void {
  const open = createOpenAttemptCallback(id);
  const {reserve, exhausted} = quotaOperations(account, signal);
  return db => { open(db); if (reserve(db) === exhausted) throw new AccountQuotaExhausted(); };
}

/** Commit the charge before opening a second writer fence around fetch initiation. */
export async function invokeAccountAttempt(account: UpstreamAccount, signal: AbortSignal, start: () => Promise<Response>, onOpen?: (attempt: AccountAttempt) => void, onCommittedExhaustion?: () => never, onCommittedConflict?: (error: AccountAttemptOpen | AccountCooldownBeforeDispatch) => never): Promise<Response> {
  const {validate, validateAuth, reserve, cooling, exhausted} = quotaOperations(account, signal);
  const attempt = {accountId:account.id, attemptId:randomUUID()};

  let day: string | null | false | typeof exhausted;
  try { day = await withAsyncWriter(db => {
    validate(db, false); validateAuth(db); signal.throwIfAborted();
    // Return, rather than throw, so only a confirmed successful commit of this
    // read-only branch can authorize reselection. Commit errors fail closed.
    if (cooling(db)) return null;
    if (db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get(account.id)) return false;
    // Exhaustion must be detected before any write. Only publish the retryable
    // outcome after this read-only transaction has committed successfully.
    const reservationDay = reserve(db);
    if (reservationDay === exhausted) return exhausted;
    db.prepare('INSERT INTO main.ordinary_account_attempts(account_id,attempt_id) VALUES (?,?)').run(account.id,attempt.attemptId);
    return reservationDay;
  }, {signal}); } catch (error: any) {
    if (typeof error?.code === 'string' && (error.code.startsWith('SQLITE_BUSY') || error.code.startsWith('SQLITE_LOCKED'))) throw new AccountQuotaUnavailable();
    throw error;
  }
  if (day === null || day === false) {
    const error = day === null ? new AccountCooldownBeforeDispatch() : new AccountAttemptOpen();
    onCommittedConflict?.(error);
    throw error;
  }
  if (day === exhausted) {
    onCommittedExhaustion?.();
    throw new AccountQuotaExhausted();
  }
  onOpen?.(attempt);
  let pending: Promise<Response> | undefined;
  let started = false;
  try {
    const result = await withAsyncWriter(db => {
      const a = validate(db);
      // Recheck under the dispatch fence: credentials or refresh intent may
      // have changed after the reservation committed.
      validateAuth(db);
      if (!db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=? AND attempt_id=?').get(account.id,attempt.attemptId)) throw new AccountQuotaUnavailable();
      const row = db.prepare('SELECT day,used,legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(account.id) as any;
      if (!row || row.day !== day || new Date().toISOString().slice(0,10) !== day || !Number.isSafeInteger(row.used) || row.used < 1 || ![0,1].includes(row.legacy_ambiguous) || (a.daily_quota > 0 && (row.legacy_ambiguous || row.used > a.daily_quota))) throw new AccountQuotaUnavailable();
      signal.throwIfAborted();
      started = true;
      pending = start();
      if (!(pending instanceof Promise)) throw new Error('Invalid fetch promise');
      return {pending};
    }, {signal});
    return result.pending;
  } catch (error: any) {
    if (pending) void pending.catch(() => {});
    if (!started) {
      try { await settleAccountAttempt(attempt); } catch { /* uncertain cleanup stays OPEN */ }
    }
    if (typeof error?.code === 'string' && (error.code.startsWith('SQLITE_BUSY') || error.code.startsWith('SQLITE_LOCKED'))) throw new AccountQuotaUnavailable();
    throw error;
  }
}
