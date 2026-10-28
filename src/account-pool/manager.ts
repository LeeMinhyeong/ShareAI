/**
 * 계정 풀 관리자 - 전략별 후보 정렬, 쿨다운, 실패/성공 기록
 * (쿨다운 지수 백오프는 OmniRoute executors/accountRotation.ts 방식)
 */
import type { UpstreamAccount, CredentialType } from '../db/schema.js';
import { AccountRepository } from '../db/repositories/accounts.js';
import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

export type SelectionStrategy = 'round_robin' | 'priority' | 'least_used';

export interface SelectOptions {
  exclude?: Set<string>;
  credentialTypes?: CredentialType[];
}

interface RotationState {
  cooldownUntil: number;
  consecutiveFails: number;
  revision: number;
}

const repo = new AccountRepository();

export class AccountPoolManager {
  private roundRobinCounters = new Map<string, number>();
  private states = new Map<string, RotationState>();

  /**
   * 전략 순서대로 정렬된 사용 가능 후보 목록 (앞에서부터 시도, 실패 시 다음)
   */
  getCandidates(provider: string, strategy: SelectionStrategy, opts: SelectOptions = {}): UpstreamAccount[] {
    const now = Date.now();
    const all = repo.findActiveByProvider(provider).filter(acc => {
      if (opts.exclude?.has(acc.id)) return false;
      if (opts.credentialTypes && !opts.credentialTypes.includes(acc.credentialType)) return false;
      if (acc.dailyQuota > 0 && acc.usedToday >= acc.dailyQuota) return false;
      if (acc.status === 'quota_exceeded') {
        const resetAt = acc.quotaInfo?.resetAt;
        if (resetAt && resetAt > now) return false;
      }
      return true;
    });

    const ready = all.filter(a => this.state(a.id, a.stateRevision).cooldownUntil <= now);
    // 모두 쿨다운 중이면 쿨다운이 가장 빨리 끝나는 계정이라도 시도
    const pool = ready.length > 0 ? ready : [...all].sort((a, b) => this.state(a.id, a.stateRevision).cooldownUntil - this.state(b.id, b.stateRevision).cooldownUntil).slice(0, 1);

    switch (strategy) {
      case 'priority':
        return [...pool].sort((a, b) => a.priority - b.priority || a.usedToday - b.usedToday);
      case 'least_used':
        return [...pool].sort((a, b) => a.usedToday - b.usedToday || a.priority - b.priority);
      case 'round_robin':
      default:
        return this.roundRobinOrder(provider, pool);
    }
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

  /** 가중치 라운드로빈: 가중치만큼 슬롯을 펼친 뒤 카운터 위치부터 순회 (중복 제거) */
  private roundRobinOrder(provider: string, pool: UpstreamAccount[]): UpstreamAccount[] {
    if (pool.length === 0) return [];
    const slots: UpstreamAccount[] = [];
    for (const acc of pool) for (let i = 0; i < Math.max(1, acc.weight); i++) slots.push(acc);
    const key = `rr:${provider}`;
    const counter = this.roundRobinCounters.get(key) ?? 0;
    this.roundRobinCounters.set(key, counter + 1);

    const ordered: UpstreamAccount[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < slots.length; i++) {
      const acc = slots[(counter + i) % slots.length];
      if (!seen.has(acc.id)) {
        seen.add(acc.id);
        ordered.push(acc);
      }
    }
    return ordered;
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

  private state(id: string, revision: number): RotationState {
    let s = this.states.get(id);
    if (!s || s.revision !== revision) {
      s = { cooldownUntil: 0, consecutiveFails: 0, revision };
      this.states.set(id, s);
    }
    return s;
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
