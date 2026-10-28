/**
 * 사용 로그 Repository
 */
import { getDb } from '../client.js';
import type { UsageLog } from '../schema.js';
import { randomUUID } from 'crypto';

export class UsageLogRepository {
  /**
   * 로그 추가
   */
  create(data: {
    userId: string;
    upstreamAccountId: string;
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    success: boolean;
    error?: string;
    latencyMs: number;
  }): UsageLog {
    const db = getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO usage_logs (
        id, user_id, upstream_account_id, timestamp, model, provider,
        input_tokens, output_tokens, success, error, latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.userId,
      data.upstreamAccountId,
      now,
      data.model,
      data.provider,
      data.inputTokens,
      data.outputTokens,
      data.success ? 1 : 0,
      data.error || null,
      data.latencyMs
    );

    return this.findById(id)!;
  }

  /**
   * ID로 로그 조회
   */
  findById(id: string): UsageLog | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM usage_logs WHERE id = ?').get(id);
    
    if (!row) return null;
    
    return this.rowToLog(row);
  }

  /**
   * 사용자별 최근 로그
   */
  findByUser(userId: string, limit: number = 100): UsageLog[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM usage_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(userId, limit);
    
    return rows.map(row => this.rowToLog(row));
  }

  /**
   * 계정별 최근 로그
   */
  findByAccount(accountId: string, limit: number = 100): UsageLog[] {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM usage_logs WHERE upstream_account_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(accountId, limit);
    
    return rows.map(row => this.rowToLog(row));
  }

  /**
   * 사용자별 오늘 통계
   */
  getTodayStats(userId: string): { totalRequests: number; successRequests: number; totalTokens: number } {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = db
      .prepare(`
        SELECT 
          COUNT(*) as total_requests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
          SUM(input_tokens + output_tokens) as total_tokens
        FROM usage_logs 
        WHERE user_id = ? AND timestamp >= ?
      `)
      .get(userId, today.toISOString()) as any;

    return {
      totalRequests: result.total_requests || 0,
      successRequests: result.success_requests || 0,
      totalTokens: result.total_tokens || 0,
    };
  }

  /**
   * 계정별 오늘 통계
   */
  getAccountTodayStats(accountId: string): { totalRequests: number; successRequests: number; totalTokens: number } {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = db
      .prepare(`
        SELECT 
          COUNT(*) as total_requests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
          SUM(input_tokens + output_tokens) as total_tokens
        FROM usage_logs 
        WHERE upstream_account_id = ? AND timestamp >= ?
      `)
      .get(accountId, today.toISOString()) as any;

    return {
      totalRequests: result.total_requests || 0,
      successRequests: result.success_requests || 0,
      totalTokens: result.total_tokens || 0,
    };
  }

  private rowToLog(row: any): UsageLog {
    return {
      id: row.id,
      userId: row.user_id,
      upstreamAccountId: row.upstream_account_id,
      timestamp: new Date(row.timestamp),
      model: row.model,
      provider: row.provider,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      success: Boolean(row.success),
      error: row.error,
      latencyMs: row.latency_ms,
    };
  }
}
