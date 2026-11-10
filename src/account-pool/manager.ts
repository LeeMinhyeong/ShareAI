/**
 * 계정 풀 관리자 - 전략별 후보 정렬, 쿨다운, 실패/성공 기록
 * (쿨다운 지수 백오프는 OmniRoute executors/accountRotation.ts 방식)
 */
import type { UpstreamAccount, CredentialType } from '../db/schema.js';
import { AccountRepository } from '../db/repositories/accounts.js';
import { getDb } from '../db/client.js';
import { assert429V2Schema } from '../db/account-429-v2-store.js';
import { withAsyncWriter } from '../db/async-writer.js';
import { logger } from '../utils/logger.js';
import { CredentialVault } from '../utils/encryption.js';
import { SiwcStore } from '../upstream/siwc-store.js';
import { decodeJwt, parseStoredCredentials } from '../upstream/oauth.js';
import { parseUsageUtc } from '../db/usage-utc.js';

export type SelectionStrategy = 'round_robin' | 'priority' | 'least_used';

export type PoolCandidate = { kind: 'upstream'; id: string; priority: number; weight: number; usedToday: number; account: UpstreamAccount } | { kind: 'siwc'; id: string; priority: number; weight: number; usedToday: number };

export interface SelectOptions {
  exclude?: Set<string>;
  excludeUpstream?: Set<string>;
  excludeSiwc?: Set<string>;
  credentialTypes?: CredentialType[];
  supportsGenerationOptions?: boolean;
}

interface RotationState {
  cooldownUntil: number;
  consecutiveFails: number;
  revision: number;
}

const repo = new AccountRepository();

export class AccountPoolManager {
  constructor(private readonly successClock: () => number = Date.now) {}

  private successDay(): [string, string] {
    const value = this.successClock();
    if (!Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) throw new RangeError('Invalid success clock');
    const asOf = new Date(value);
    if (asOf.getUTCFullYear() < 0 || asOf.getUTCFullYear() > 9999) throw new RangeError('Unsupported success clock year');
    const start = new Date(asOf);
    start.setUTCHours(0, 0, 0, 0);
    return [start.toISOString(), asOf.toISOString()];
  }

  private successes(kind: 'upstream' | 'siwc', id: string, day: [string, string]): number {
    // Restrict each supported raw representation to the UTC day before strict validation.
    // SQLite date functions normalize impossible dates and round sub-millisecond input.
    const sql = kind === 'upstream'
      ? 'SELECT timestamp FROM usage_logs WHERE upstream_account_id=? AND success=1 AND ((timestamp>=? AND timestamp<=?) OR (timestamp>=? AND timestamp<=?))'
      : 'SELECT timestamp FROM siwc_usage_logs WHERE account_id=? AND success=1 AND aborted=0 AND ((timestamp>=? AND timestamp<=?) OR (timestamp>=? AND timestamp<=?))';
    const start = day[0].slice(0, 10);
    const end = day[1];
    const rows = getDb().prepare(sql).iterate(id, `${start} 00:00:00`, `${end.slice(0, 10)} ${end.slice(11, 19)}`, day[0], end) as Iterable<{timestamp: unknown}>;
    let count = 0;
    for (const {timestamp} of rows) {
      const ms = parseUsageUtc(timestamp);
      if (ms !== null && ms >= Date.parse(day[0]) && ms <= Date.parse(end)) count++;
    }
    return count;
  }

  private upstreamSuccesses(id: string, day: [string, string]): number {
    return this.successes('upstream', id, day);
  }

  private roundRobinCounters = new Map<string, bigint>();
  private states = new Map<string, RotationState>();
  // SIWC revisions and identifiers are separate from ordinary accounts.
  private siwcStates = new Map<string, {revision: string; cooldownUntil: number; consecutiveFails: number}>();

  /** Conservative shared 5xx wait using the existing process-local backoff history. */
  shared5xxBackoffMs(kind: 'upstream' | 'siwc', id: string, revision: number | string): number {
    const previous = kind === 'upstream' ? this.states.get(id) : this.siwcStates.get(id);
    const failures = previous?.revision === revision ? previous.consecutiveFails : 0;
    // Use the upper end of the current 0–1s jitter so a shared restriction
    // cannot expire sooner than the corresponding process-local backoff.
    return Math.min(5000 * 2 ** failures + 1000, 300_000);
  }

  siwcCooling(id: string, revision: string): boolean {
    const state = this.siwcStates.get(id);
    return !!state && state.revision === revision && state.cooldownUntil > Date.now();
  }

  // Failure replaces the state object, so an older in-flight success cannot clear it.
  siwcFailureMarker(id: string) { return this.siwcStates.get(id); }

  recordSiwcSuccess(id: string, revision: string, marker: ReturnType<AccountPoolManager['siwcFailureMarker']>): void {
    const current = getDb().prepare('SELECT revision FROM siwc_credentials WHERE id=?').get(id) as {revision: string} | undefined;
    if (current?.revision === revision && this.siwcStates.get(id) === marker) this.siwcStates.delete(id);
  }

  recordSiwcFailure(id: string, revision: string): void {
    const current = getDb().prepare('SELECT revision FROM siwc_credentials WHERE id=?').get(id) as {revision: string} | undefined;
    if (!current || current.revision !== revision) return;
    const previous = this.siwcStates.get(id);
    const consecutiveFails = previous?.revision === revision ? previous.consecutiveFails + 1 : 1;
    this.siwcStates.set(id, {revision, consecutiveFails, cooldownUntil: Date.now() + Math.min(5000 * 2 ** (consecutiveFails - 1) + Math.random() * 1000, 300_000)});
  }

  /**
   * 전략 순서대로 정렬된 사용 가능 후보 목록 (앞에서부터 시도, 실패 시 다음)
   */
  getCandidates(provider: string, strategy: SelectionStrategy, opts: SelectOptions = {}): UpstreamAccount[] {
    const ready = this.eligibleUpstream(provider, opts);
    if (strategy === 'least_used' || strategy === 'priority') {
      const day = this.successDay();
      const ranked = ready.map(account => ({account, priority:account.priority, weight:account.weight, usedToday:this.upstreamSuccesses(account.id, day)}));
      return this.order(provider, ranked, strategy, a => a.account.id).map(a => a.account);
    }
    return this.order(provider, ready, strategy, a => a.id);
  }

  private eligibleUpstream(provider: string, opts: SelectOptions): UpstreamAccount[] {
    const now = Date.now();
    const db = getDb();
    // Staged integration only: settlement/startup must be wired before deployment.
    assert429V2Schema(db);
    const restricted = db.prepare('SELECT 1 FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?');
    const all = repo.findActiveByProvider(provider).filter(acc => {
      if (opts.exclude?.has(acc.id) || opts.excludeUpstream?.has(acc.id)) return false;
      if (opts.credentialTypes && !opts.credentialTypes.includes(acc.credentialType)) return false;
      if (provider === 'openai' && opts.supportsGenerationOptions && acc.credentialType === 'oauth') return false;
      if (provider === 'anthropic' && acc.credentialType === 'oauth') {
        const creds = parseStoredCredentials(acc.credentials);
        if (creds) {
          const expired = creds.expiresAt != null && creds.expiresAt <= now;
          // Conservative for normal resolution: an existing or forced refresh can
          // still recover a falsey expiry, but that state is not available here.
          const willRefresh = !!creds.refreshToken && !!creds.expiresAt;
          if (expired && !willRefresh) return false;
        }
      }
      if (provider === 'openai' && acc.credentialType === 'oauth') {
        const creds = parseStoredCredentials(acc.credentials);
        if (!creds) return false;
        const exp = decodeJwt(creds.accessToken)?.exp;
        const jwtExpired = typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 <= now;
        const expired = (creds.expiresAt != null && creds.expiresAt <= now) || jwtExpired;
        const refreshable = typeof creds.refreshToken === 'string' && !!creds.refreshToken.trim();
        if (typeof creds.refreshToken === 'string' && creds.refreshToken && repo.hasRefreshIntent(provider, creds.refreshToken)) return false;
        const willRefresh = refreshable && (jwtExpired || (!!creds.expiresAt && creds.expiresAt - now < 5 * 60 * 1000));
        if (expired && !willRefresh) return false;
        if (!willRefresh && !/^[A-Za-z0-9._~+/-]+=*$/.test(creds.accessToken)) return false;
        if ((typeof creds.accountId !== 'string' || !creds.accountId.trim() || /[\x00-\x1f\x7f]/.test(creds.accountId)) &&
            !(willRefresh && (creds.accountId == null || creds.accountId === ''))) return false;
      }
      // Shared cooldown is advisory here; the dispatch fence rechecks under the writer.
      if (restricted.get('upstream', acc.id)) return false;
      if (getDb().prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get(acc.id)) return false;
      // Advisory filtering permits fallback to another account; the claim still decides atomically.
      const quota = getDb().prepare('SELECT day, used, legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(acc.id) as {day:string; used:number; legacy_ambiguous:number} | undefined;
      const day = new Date().toISOString().slice(0,10);
      if (!Number.isSafeInteger(acc.dailyQuota) || acc.dailyQuota < 0) return false;
      if (quota && (!/^\d{4}-\d{2}-\d{2}$/.test(quota.day) || Number.isNaN(Date.parse(`${quota.day}T00:00:00Z`)) || new Date(`${quota.day}T00:00:00Z`).toISOString().slice(0,10) !== quota.day || quota.day > day || !Number.isSafeInteger(quota.used) || quota.used < 0 || ![0,1].includes(quota.legacy_ambiguous))) return false;
      if (quota?.day === day && (quota.used === Number.MAX_SAFE_INTEGER || (acc.dailyQuota > 0 && (quota.legacy_ambiguous || quota.used >= acc.dailyQuota)))) return false;
      if (acc.status === 'quota_exceeded') {
        const resetAt = acc.quotaInfo?.resetAt;
        if (resetAt && resetAt > now) return false;
      }
      return true;
    });

    return all.filter(a => this.state(a.id, a.stateRevision).cooldownUntil <= now);
  }

  private order<T extends {priority: number; usedToday: number; weight: number}>(provider: string, pool: T[], strategy: SelectionStrategy, keyOf: (a: T) => string): T[] {
    switch (strategy) {
      case 'priority': return [...pool].sort((a, b) => a.priority - b.priority || a.usedToday - b.usedToday || keyOf(a).localeCompare(keyOf(b)));
      case 'least_used': return [...pool].sort((a, b) => a.usedToday - b.usedToday || a.priority - b.priority || keyOf(a).localeCompare(keyOf(b)));
      default: return this.roundRobinOrder(provider, [...pool].sort((a,b) => keyOf(a).localeCompare(keyOf(b))), keyOf);
    }
  }

  /** Mix only enabled, user-authorized SIWC accounts with ordinary candidates. */
  async selectCandidate(userId: string, model: string, provider: string, strategy: SelectionStrategy, opts: SelectOptions = {}): Promise<PoolCandidate | null> {
    const db = getDb();
    assert429V2Schema(db);
    const restricted = db.prepare('SELECT 1 FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?');
    const exists = provider === 'openai' && db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('siwc_accounts','siwc_credentials')").get() as {n:number} | false;
    // Round robin exposes the legacy local-midnight count on its returned candidate.
    // UTC-ranked strategies replace it below, so avoid the correlated count entirely.
    const legacyCount = strategy === 'round_robin';
    const countExpression = legacyCount ? '(SELECT COUNT(*) FROM siwc_usage_logs l WHERE l.account_id=a.id AND l.success=1 AND l.timestamp>=?)' : '0';
    let siwc = exists && exists.n === 2 && !opts.supportsGenerationOptions && (!opts.credentialTypes || opts.credentialTypes.includes('oauth')) ? db.prepare(`SELECT a.id, COALESCE(r.priority,0) AS priority, COALESCE(r.weight,1) AS weight, ${countExpression} AS usedToday
      FROM siwc_accounts a JOIN siwc_credentials c ON c.id=a.id JOIN siwc_access_policy p ON p.account_id=a.id LEFT JOIN siwc_routing_settings r ON r.account_id=a.id
      JOIN users u ON u.id=? AND u.enabled=1 WHERE p.enabled=1 AND (p.scope='all' OR (p.scope='selected' AND EXISTS
      (SELECT 1 FROM siwc_access_users g WHERE g.account_id=a.id AND g.user_id=u.id))) ORDER BY a.id`).all(...(legacyCount ? [new Date(new Date().setHours(0,0,0,0)).toISOString(), userId] : [userId])) as {id:string;priority:number;weight:number;usedToday:number}[] : [];
    if (siwc.length) {
      const store = new SiwcStore(db, new CredentialVault(), { initialize: false });
      siwc = siwc.filter(({id}) => {
        if (opts.exclude?.has(id) || opts.excludeSiwc?.has(id)) return false;
        if (restricted.get('siwc', id)) return false;
        if (db.prepare('SELECT 1 FROM main.siwc_account_attempts WHERE account_id=?').get(id)) return false;
        try {
          const snapshot = store.readSnapshot(id);
          const credential = snapshot?.credential;
          if (!snapshot || this.siwcCooling(id, snapshot.revision) || !credential || !credential.scopes.includes('chatgpt.tokens.use.direct')) return false;
          const expired = Date.parse(credential.savedAt) + credential.expiresIn * 1000 <= Date.now();
          if (!expired) return true;
          return !!credential.refreshToken && credential.scopes.includes('offline_access')
            && (credential.earliestRefreshAt === undefined || credential.earliestRefreshAt * 1000 <= Date.now())
            && !repo.hasRefreshIntent('openai', credential.refreshToken);
        } catch { return false; }
      });
    }
    if (!siwc.length) {
      if (strategy === 'least_used' || strategy === 'priority') {
        const day = this.successDay();
        const ranked = this.eligibleUpstream(provider, opts).map(account => ({kind:'upstream' as const, id:account.id, priority:account.priority, weight:account.weight, usedToday:this.upstreamSuccesses(account.id, day), account}));
        return this.order(provider, ranked, strategy, a => a.id)[0] ?? null;
      }
      const account = await this.selectAccount(userId, model, provider, strategy, opts);
      return account ? {kind:'upstream', id:account.id, priority:account.priority, weight:account.weight, usedToday:account.usedToday, account} : null;
    }
    // For mixed priority ties and least-used, compare best-effort completed successes
    // for both kinds in one captured UTC interval; this is not quota admission.
    if (strategy === 'least_used' || strategy === 'priority') {
      const day = this.successDay();
      siwc = siwc.map(a => ({...a, usedToday:this.successes('siwc', a.id, day)}));
      const upstream = this.eligibleUpstream(provider, opts).map(account => ({kind:'upstream' as const, id:account.id, priority:account.priority, weight:account.weight, usedToday:this.upstreamSuccesses(account.id, day), account}));
      const candidates: PoolCandidate[] = [...upstream, ...siwc.map(a => ({kind:'siwc' as const, ...a}))];
      return this.order(provider, candidates, strategy, a => `${a.kind}:${a.id}`)[0] ?? null;
    }
    // Extract the eligible upstream set without advancing the shared rotation counter.
    const upstream = this.eligibleUpstream(provider, opts).map(account => ({kind:'upstream' as const, id:account.id, priority:account.priority, weight:account.weight, usedToday:account.usedToday, account}));
    const candidates: PoolCandidate[] = [...upstream, ...siwc.map(a => ({kind:'siwc' as const, ...a}))];
    return this.order(provider, candidates, strategy, a => `${a.kind}:${a.id}`)[0] ?? null;
  }

  /** 하위호환: 첫 번째 후보 */
  async selectAccount(
    userId: string,
    model: string,
    provider: string,
    strategy: SelectionStrategy = 'priority',
    opts: SelectOptions = {}
  ): Promise<UpstreamAccount | null> {
    const list = this.getCandidates(provider, strategy, opts);
    if (list.length === 0) logger.warn({ userId, model, provider }, 'No available accounts');
    return list[0] ?? null;
  }

  /** Weighted slots are represented by ranges, never materialized. */
  private roundRobinOrder<T extends {weight:number}>(provider: string, pool: T[], keyOf: (a:T) => string): T[] {
    if (pool.length === 0) return [];
    const weights = pool.map(a => typeof a.weight === 'number' && Number.isFinite(a.weight) && a.weight > 0 ? BigInt(Math.ceil(a.weight)) : 1n);
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    const key = JSON.stringify([provider, pool.map(keyOf)]);
    const position = (this.roundRobinCounters.get(key) ?? 0n) % total;
    // Bound state for arbitrary ACL/exclusion combinations, with LRU eviction.
    this.roundRobinCounters.delete(key);
    this.roundRobinCounters.set(key, (position + 1n) % total);
    if (this.roundRobinCounters.size > 1024) this.roundRobinCounters.delete(this.roundRobinCounters.keys().next().value!);
    let remaining = position;
    let index = 0;
    while (remaining >= weights[index]) remaining -= weights[index++];
    return [...pool.slice(index), ...pool.slice(0, index)];
  }

  recordSuccess(accountId: string, countUsage = true, observed?: UpstreamAccount, usedToken?: string): void {
    getDb().transaction(() => {
      if (!repo.markUsed(accountId, observed, usedToken, countUsage)) return;
      const s = this.state(accountId, repo.findById(accountId)!.stateRevision);
      s.consecutiveFails = 0;
      s.cooldownUntil = 0;
    }).immediate();
  }

  /**
   * 업스트림 실패 기록
   *  - 429: quota_exceeded (resetAt 있으면 그때까지 제외)
   *  - 401/403: 자격증명 오류 → error (대시보드에서 재연결 필요)
   *  - 5xx/네트워크: 상태는 유지, 쿨다운만
   */
  recordFailure(accountId: string, f: { status: number; message: string; resetAt?: number | null }, observed?: UpstreamAccount, usedToken?: string): void {
    getDb().transaction(() => {
      const before = repo.findById(accountId);
      if (!repo.recordObservedFailure(accountId, f.status, f.message, observed, usedToken)) return;
      const s = this.state(accountId, before!.stateRevision);
      s.revision = repo.findById(accountId)!.stateRevision;
      s.consecutiveFails++;
      const backoff = Math.min(5000 * 2 ** (s.consecutiveFails - 1) + Math.random() * 1000, 300_000);
      s.cooldownUntil = Date.now() + backoff;

      if (f.status === 429 && f.resetAt && f.resetAt > Date.now()) s.cooldownUntil = Math.max(s.cooldownUntil, f.resetAt);

      logger.warn({ accountId, status: f.status, cooldownMs: s.cooldownUntil - Date.now() }, 'Upstream account failure');
    }).immediate();
  }

  async recordSuccessAsync(accountId: string, countUsage: boolean, observed: UpstreamAccount, usedToken?: string): Promise<void> {
    const revision = await withAsyncWriter(db => {
      if (!repo.markUsed(accountId, observed, usedToken, countUsage, db)) return null;
      return repo.findById(accountId, db)!.stateRevision;
    });
    if (revision === null) return;
    const s = this.state(accountId, revision);
    s.consecutiveFails = 0;
    s.cooldownUntil = 0;
  }

  async recordFailureAsync(accountId: string, f: {status:number; message:string; resetAt?:number | null}, observed: UpstreamAccount, usedToken?: string, signal?: AbortSignal): Promise<void> {
    const revisions = await withAsyncWriter(db => {
      const before = repo.findById(accountId, db);
      if (!repo.recordObservedFailure(accountId, f.status, f.message, observed, usedToken, db)) return null;
      return {before:before!.stateRevision, after:repo.findById(accountId, db)!.stateRevision};
    }, {signal});
    if (!revisions) return;
    const s = this.state(accountId, revisions.before);
    s.revision = revisions.after;
    s.consecutiveFails++;
    s.cooldownUntil = Date.now() + Math.min(5000 * 2 ** (s.consecutiveFails - 1) + Math.random() * 1000, 300_000);
    if (f.status === 429 && f.resetAt && f.resetAt > Date.now()) s.cooldownUntil = Math.max(s.cooldownUntil, f.resetAt);
    logger.warn({accountId, status:f.status, cooldownMs:s.cooldownUntil-Date.now()}, 'Upstream account failure');
  }

  private state(id: string, revision: number): RotationState {
    let s = this.states.get(id);
    if (!s || s.revision !== revision) {
      s = { cooldownUntil: 0, consecutiveFails: 0, revision };
      this.states.set(id, s);
    }
    return s;
  }

  /** Read local cooldown without decrypting credentials or altering pool state. */
  observedCooldown(id: string, revision: number): number {
    const state = this.states.get(id);
    return state?.revision === revision ? state.cooldownUntil : 0;
  }

  cooldownOf(id: string): number {
    const account = repo.findById(id);
    return account ? this.state(id, account.stateRevision).cooldownUntil : 0;
  }

  // ---- v1 /chat/completions (레거시 경로) 호환 ----
  async updateAccountStatus(accountId: string, result: { success: boolean; error?: Error; tokensUsed?: number }): Promise<void> {
    if (result.success) return this.recordSuccess(accountId);
    const msg = result.error?.message ?? 'Unknown error';
    const status = Number(msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 500);
    this.recordFailure(accountId, { status, message: msg.slice(0, 300) });
  }

  async resetDailyQuotas(): Promise<void> {
    repo.resetDailyQuotas();
    logger.info('Daily quotas reset');
  }
}

/** 라우트 간 공유 (라운드로빈 카운터/쿨다운 상태 유지) */
export const accountPool = new AccountPoolManager();
