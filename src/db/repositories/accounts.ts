/**
 * 업스트림 계정 Repository
 */
import { getDb } from '../client.js';
import type { UpstreamAccount } from '../schema.js';
import { randomUUID } from 'crypto';
import { CredentialVault } from '../../utils/encryption.js';

const vault = new CredentialVault();

export class AccountRepository {
  /**
   * ID로 계정 조회
   */
  findById(id: string): UpstreamAccount | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM upstream_accounts WHERE id = ?').get(id);
    
    if (!row) return null;
    
    return this.rowToAccount(row);
  }

  /**
   * 제공자별 활성 계정 조회
   */
  findActiveByProvider(provider: string): UpstreamAccount[] {
    const db = getDb();
    const rows = db
      .prepare(`
        SELECT * FROM upstream_accounts 
        WHERE provider = ? AND status IN ('active', 'quota_exceeded')
        ORDER BY priority ASC, name ASC
      `)
      .all(provider);
    
    return rows.map(row => this.rowToAccount(row));
  }

  /**
   * 계정 생성
   */
  create(data: {
    name: string;
    provider: 'anthropic' | 'openai' | 'google';
    credentialType: 'cookie' | 'api_key' | 'session_token';
    credentials: string;
    dailyQuota?: number;
    priority?: number;
    weight?: number;
  }): UpstreamAccount {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);

    // 자격증명 암호화
    const encryptedCreds = vault.encrypt(data.credentials);

    db.prepare(`
      INSERT INTO upstream_accounts (
        id, name, provider, credential_type, credentials,
        status, last_used, last_error,
        daily_quota, used_today, quota_reset_at,
        priority, weight,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.provider,
      data.credentialType,
      encryptedCreds,
      data.dailyQuota ?? 0,
      tomorrow.toISOString(),
      data.priority ?? 0,
      data.weight ?? 1,
      now,
      now
    );

    return this.findById(id)!;
  }

  /**
   * 계정 업데이트
   */
  update(
    id: string,
    data: Partial<
      Pick<
        UpstreamAccount,
        'name' | 'status' | 'lastError' | 'dailyQuota' | 'priority' | 'weight' | 'credentials'
      >
    >
  ): void {
    const db = getDb();
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }
    if (data.lastError !== undefined) {
      updates.push('last_error = ?');
      values.push(data.lastError);
    }
    if (data.dailyQuota !== undefined) {
      updates.push('daily_quota = ?');
      values.push(data.dailyQuota);
    }
    if (data.priority !== undefined) {
      updates.push('priority = ?');
      values.push(data.priority);
    }
    if (data.weight !== undefined) {
      updates.push('weight = ?');
      values.push(data.weight);
    }
    if (data.credentials !== undefined) {
      updates.push('credentials = ?');
      values.push(vault.encrypt(data.credentials));
    }

    if (updates.length === 0) return;

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE upstream_accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 마지막 사용 시각 업데이트
   */
  markUsed(id: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE upstream_accounts 
      SET last_used = ?, used_today = used_today + 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), id);
  }

  /**
   * 할당량 초과 표시
   */
  markQuotaExceeded(id: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE upstream_accounts 
      SET status = 'quota_exceeded', last_error = 'Daily quota exceeded', updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  /**
   * 오류 표시
   */
  markError(id: string, error: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE upstream_accounts 
      SET status = 'error', last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(error, new Date().toISOString(), id);
  }

  /**
   * 할당량 리셋 (매일 자동 실행)
   */
  resetDailyQuotas(): void {
    const db = getDb();
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);

    db.prepare(`
      UPDATE upstream_accounts 
      SET used_today = 0, 
          quota_reset_at = ?,
          status = CASE 
            WHEN status = 'quota_exceeded' THEN 'active'
            ELSE status
          END,
          updated_at = ?
      WHERE quota_reset_at <= ?
    `).run(tomorrow.toISOString(), new Date().toISOString(), new Date().toISOString());
  }

  /**
   * 모든 계정 조회
   */
  findAll(): UpstreamAccount[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM upstream_accounts ORDER BY provider, priority, name').all();
    return rows.map(row => this.rowToAccount(row));
  }

  /**
   * 계정 삭제
   */
  delete(id: string): void {
    const db = getDb();
    db.prepare('DELETE FROM upstream_accounts WHERE id = ?').run(id);
  }

  private rowToAccount(row: any): UpstreamAccount {
    // 자격증명 복호화
    let credentials = row.credentials;
    try {
      credentials = vault.decrypt(row.credentials);
    } catch (e) {
      // 암호화되지 않은 평문일 수 있음 (마이그레이션 전)
    }

    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      credentialType: row.credential_type,
      credentials,
      status: row.status,
      lastUsed: row.last_used ? new Date(row.last_used) : null,
      lastError: row.last_error,
      dailyQuota: row.daily_quota,
      usedToday: row.used_today,
      quotaResetAt: new Date(row.quota_reset_at),
      priority: row.priority,
      weight: row.weight,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
