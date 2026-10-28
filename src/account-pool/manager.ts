/**
 * 계정 풀 관리자 - 계정 선택 및 상태 추적
 */

import type { UpstreamAccount } from '../db/schema.js';
import { logger } from '../utils/logger.js';

export type SelectionStrategy = 'round_robin' | 'priority' | 'least_used';

export interface AccountFilter {
  provider?: string;
  status?: string;
  hasQuotaRemaining?: boolean;
  accountIds?: string[];
}

interface RotatableAccount {
  fingerprint: string;
  cooldownUntil: number;
  consecutiveFails: number;
  proxy: null;
}

/**
 * 계정 풀 관리자
 */
export class AccountPoolManager {
  private roundRobinCounters = new Map<string, number>();
  private accountStates = new Map<string, RotatableAccount>();

  /**
   * 조건에 맞는 계정 선택
   */
  async selectAccount(
    userId: string,
    model: string,
    provider: string,
    filter: AccountFilter = {},
    strategy: SelectionStrategy = 'round_robin'
  ): Promise<UpstreamAccount | null> {
    const candidates = await this.filterAccounts({
      ...filter,
      provider,
      status: 'active',
      hasQuotaRemaining: true,
    });

    if (candidates.length === 0) {
      logger.warn({ userId, model, provider }, 'No available accounts');
      return null;
    }

    logger.debug(
      { userId, model, provider, candidateCount: candidates.length, strategy },
      'Selecting account'
    );

    switch (strategy) {
      case 'round_robin':
        return this.roundRobinSelect(provider, candidates);
      case 'priority':
        return this.prioritySelect(candidates);
      case 'least_used':
        return this.leastUsedSelect(candidates);
      default:
        return candidates[0];
    }
  }

  /**
   * 라운드로빈 선택 (가중치 고려)
   */
  private roundRobinSelect(
    provider: string,
    candidates: UpstreamAccount[]
  ): UpstreamAccount {
    const key = `rr:${provider}`;
    const counter = this.roundRobinCounters.get(key) ?? 0;

    // 가중치 적용된 후보 목록 생성
    const weighted: UpstreamAccount[] = [];
    for (const account of candidates) {
      for (let i = 0; i < account.weight; i++) {
        weighted.push(account);
      }
    }

    const selected = weighted[counter % weighted.length];
    this.roundRobinCounters.set(key, counter + 1);

    return selected;
  }

  /**
   * 우선순위 기반 선택 (priority 낮을수록 먼저)
   */
  private prioritySelect(candidates: UpstreamAccount[]): UpstreamAccount {
    return candidates.sort((a, b) => a.priority - b.priority)[0];
  }

  /**
   * 최소 사용 선택
   */
  private leastUsedSelect(candidates: UpstreamAccount[]): UpstreamAccount {
    return candidates.sort((a, b) => a.usedToday - b.usedToday)[0];
  }

  /**
   * 계정 필터링 (실제 DB 쿼리)
   */
  private async filterAccounts(filter: AccountFilter): Promise<UpstreamAccount[]> {
    const { AccountRepository } = await import('../db/repositories/accounts.js');
    const repo = new AccountRepository();
    
    if (!filter.provider) return [];
    
    const accounts = repo.findActiveByProvider(filter.provider);
    
    return accounts.filter(acc => {
      if (acc.status === 'error') return false;
      if (filter.hasQuotaRemaining && acc.dailyQuota > 0 && acc.usedToday >= acc.dailyQuota) {
        return false;
      }
      return true;
    });
  }

  /**
   * 계정 사용 후 상태 업데이트
   */
  async updateAccountStatus(
    accountId: string,
    result: {
      success: boolean;
      error?: Error;
      tokensUsed?: number;
      latencyMs?: number;
    }
  ): Promise<void> {
    const { AccountRepository } = await import('../db/repositories/accounts.js');
    const repo = new AccountRepository();

    if (result.success) {
      repo.markUsed(accountId);
      
      const rotState = this.accountStates.get(accountId);
      if (rotState) {
        rotState.consecutiveFails = 0;
        rotState.cooldownUntil = 0;
      }
      
      logger.debug({ accountId, tokensUsed: result.tokensUsed }, 'Account usage updated');
    } else {
      const errorMsg = result.error?.message ?? 'Unknown error';
      
      if (errorMsg.includes('429')) {
        repo.markQuotaExceeded(accountId);
        logger.warn({ accountId }, 'Account quota exceeded');
      } else if (errorMsg.match(/40[13]/)) {
        repo.markError(accountId, 'Invalid credentials');
        logger.error({ accountId }, 'Account credentials invalid');
      } else {
        repo.markError(accountId, errorMsg);
        logger.error({ accountId, error: errorMsg }, 'Account error');
      }

      const account = repo.findById(accountId);
      if (account) {
        const rotState = this.getRotationState(account);
        this.markCooldown(rotState);
      }
    }
  }

  /**
   * OmniRoute rotation 상태 가져오기
   */
  private getRotationState(account: UpstreamAccount): RotatableAccount {
    const existing = this.accountStates.get(account.id);
    if (existing) return existing;

    const state: RotatableAccount = {
      fingerprint: account.id,
      cooldownUntil: 0,
      consecutiveFails: 0,
      proxy: null,
    };

    this.accountStates.set(account.id, state);
    return state;
  }

  /**
   * OmniRoute 쿨다운 로직 (exponential backoff)
   */
  private markCooldown(account: RotatableAccount): void {
    account.consecutiveFails++;
    
    const base = 5000;
    const backoff = base * Math.pow(2, account.consecutiveFails - 1);
    const jitter = Math.random() * 1000;
    const cooldown = Math.min(backoff + jitter, 300000);

    account.cooldownUntil = Date.now() + cooldown;

    logger.debug(
      { fingerprint: account.fingerprint, consecutiveFails: account.consecutiveFails, cooldownMs: cooldown },
      'Account marked cooldown'
    );
  }

  /**
   * 매일 할당량 리셋
   */
  async resetDailyQuotas(): Promise<void> {
    const { AccountRepository } = await import('../db/repositories/accounts.js');
    const repo = new AccountRepository();
    repo.resetDailyQuotas();
    logger.info('Daily quotas reset');
  }
}
