/**
 * 사용자 Repository
 */
import { getDb } from '../client.js';
import type { User } from '../schema.js';
import { randomUUID } from 'crypto';

export class UserRepository {
  /**
   * API 키로 사용자 조회
   */
  findByApiKeyHash(apiKeyHash: string): User | null {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM users WHERE api_key_hash = ? AND enabled = 1')
      .get(apiKeyHash);
    
    if (!row) return null;
    
    return this.rowToUser(row);
  }

  /**
   * ID로 사용자 조회
   */
  findById(id: string): User | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    
    if (!row) return null;
    
    return this.rowToUser(row);
  }

  /**
   * 사용자 생성
   */
  create(data: {
    apiKeyHash: string;
    name: string;
    email: string;
    tier: 'free' | 'pro';
    dailyLimit: number;
  }): User {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, api_key_hash, name, email, tier, daily_limit, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, data.apiKeyHash, data.name, data.email, data.tier, data.dailyLimit, now, now);

    return this.findById(id)!;
  }

  /**
   * 사용자 목록 조회
   */
  findAll(): User[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    return rows.map(row => this.rowToUser(row));
  }

  /**
   * 사용자 업데이트
   */
  update(id: string, data: Partial<Pick<User, 'name' | 'email' | 'tier' | 'dailyLimit' | 'enabled'>>): void {
    const db = getDb();
    const updates: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.email !== undefined) {
      updates.push('email = ?');
      values.push(data.email);
    }
    if (data.tier !== undefined) {
      updates.push('tier = ?');
      values.push(data.tier);
    }
    if (data.dailyLimit !== undefined) {
      updates.push('daily_limit = ?');
      values.push(data.dailyLimit);
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(data.enabled ? 1 : 0);
    }

    if (updates.length === 0) return;

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * 오늘 사용량 조회
   */
  getTodayUsageCount(userId: string): number {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = db
      .prepare('SELECT COUNT(*) as count FROM usage_logs WHERE user_id = ? AND timestamp >= ? AND success = 1')
      .get(userId, today.toISOString()) as { count: number };

    return result.count;
  }

  private rowToUser(row: any): User {
    return {
      id: row.id,
      apiKeyHash: row.api_key_hash,
      name: row.name,
      email: row.email,
      tier: row.tier,
      dailyLimit: row.daily_limit,
      enabled: Boolean(row.enabled),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
