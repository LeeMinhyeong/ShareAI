/**
 * 사용 로그 Repository
 */
import { getDb } from '../client.js';
import type { UsageLog } from '../schema.js';
import { randomUUID } from 'crypto';
import { parseUsageUtc } from '../usage-utc.js';

// Register a deterministic parser; invalid and unsupported representations sort last.
function historyDb() {
  const db = getDb();
  db.function('usage_utc_ms', { deterministic: true }, parseUsageUtc);
  return db;
}

// The numeric compatibility field is bounded when SQLite's floating total cannot
// be represented within the safe integer range. A null TOTAL (opposing infinities)
// uses the positive bound as a sentinel; callers must check completeness.
function boundedTokenTotal(value: number | null): number {
  if (value === null || Number.isNaN(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
}

export class UsageLogRepository {
  /** Best-effort completed logs, including failures and aborted SIWC requests. */
  getGlobalTodayCounts(): { totalRequests: number; successRequests: number } {
    const db = historyDb();
    const now = Date.now();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    // These are only prefilters: the strict parser below remains authoritative.
    // Binary ranges are separate because space and T formats are not chronologically
    // ordered relative to one another. No index is required for correctness.
    const day = start.toISOString().slice(0, 10);
    const asOf = new Date(now).toISOString();
    const sqliteRange = `timestamp COLLATE BINARY BETWEEN :sqliteStart AND :sqliteEnd`;
    const isoRange = `timestamp COLLATE BINARY BETWEEN :isoStart AND :isoEnd`;
    const row = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successful
      FROM (SELECT timestamp,success FROM usage_logs WHERE ${sqliteRange}
        UNION ALL SELECT timestamp,success FROM usage_logs WHERE ${isoRange}
        UNION ALL SELECT timestamp,success FROM siwc_usage_logs WHERE ${sqliteRange}
        UNION ALL SELECT timestamp,success FROM siwc_usage_logs WHERE ${isoRange})
      WHERE usage_utc_ms(timestamp) BETWEEN :start AND :now`).get({
        sqliteStart: `${day} 00:00:00`, sqliteEnd: asOf.slice(0, 19).replace('T', ' '),
        isoStart: `${day}T00:00:00.000Z`, isoEnd: asOf,
        start: start.getTime(), now,
      }) as {total:number;successful:number|null};
    return {totalRequests:row.total, successRequests:row.successful ?? 0};
  }
  /**
   * 로그 추가
   */
  create(data: {
    userId: string;
    upstreamAccountId: string;
    model: string;
    provider: string;
    inputTokens: number | null;
    outputTokens: number | null;
    success: boolean;
    error?: string;
    latencyMs: number;
    completedAtMs?: number;
  }, writer?: import('better-sqlite3').Database): UsageLog {
    const db = writer ?? getDb();
    const id = randomUUID();
    const completedAtMs = data.completedAtMs === undefined ? Date.now() : data.completedAtMs;
    if (!Number.isSafeInteger(completedAtMs) || Math.abs(completedAtMs) > 8640000000000000) throw new RangeError('Invalid usage completion time');
    if (!Number.isSafeInteger(data.latencyMs) || data.latencyMs < 0) throw new RangeError('Invalid usage latency');
    const now = new Date(completedAtMs).toISOString();

    db.prepare(`
      INSERT INTO usage_logs (
        id, user_id, upstream_account_id, timestamp, model, provider,
        input_tokens, output_tokens, usage_known, success, error, latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.userId,
      data.upstreamAccountId,
      now,
      data.model,
      data.provider,
      data.inputTokens,
      data.outputTokens,
      data.inputTokens === null && data.outputTokens === null ? 0 : 1,
      data.success ? 1 : 0,
      data.error || null,
      data.latencyMs
    );

    return this.rowToLog(db.prepare('SELECT * FROM usage_logs WHERE id = ?').safeIntegers().get(id));
  }

  /**
   * ID로 로그 조회
   */
  findById(id: string): UsageLog | null {
    const db = getDb();
    const row = db.prepare('SELECT * FROM usage_logs WHERE id = ?').safeIntegers().get(id);
    
    if (!row) return null;
    
    return this.rowToLog(row);
  }

  /**
   * 사용자별 최근 로그
   */
  findByUser(userId: string, limit: number = 100, offset: number = 0): UsageLog[] {
    const db = historyDb();
    const rows = db
      .prepare(`SELECT * FROM (
        SELECT id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,usage_known,success,error,latency_ms,'upstream' AS account_kind,upstream_account_id AS account_id FROM usage_logs
        UNION ALL
        SELECT id,user_id,NULL,timestamp,model,provider,input_tokens,output_tokens,1,success,NULL,latency_ms,'siwc',account_id FROM siwc_usage_logs
      ) WHERE user_id = ? ORDER BY usage_utc_ms(timestamp) DESC, id DESC, account_kind DESC LIMIT ? OFFSET ?`)
      .safeIntegers().all(userId, limit, offset);
    
    return rows.map(row => this.rowToLog(row));
  }

  /**
   * 계정별 최근 로그
   */
  findByAccount(accountId: string, limit: number = 100, offset: number = 0): UsageLog[] {
    const db = historyDb();
    const rows = db
      .prepare('SELECT * FROM usage_logs WHERE upstream_account_id = ? ORDER BY usage_utc_ms(timestamp) DESC, id DESC LIMIT ? OFFSET ?')
      .safeIntegers().all(accountId, limit, offset);
    
    return rows.map(row => this.rowToLog(row));
  }

  /**
   * 사용자별 오늘 통계
   */
  getTodayStats(userId: string): { totalRequests: number; successRequests: number; totalTokens: number; totalTokensComplete: boolean } {
    const db = historyDb();
    const now = Date.now();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    const result = db
      .prepare(`
        SELECT 
          COUNT(*) as total_requests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
          TOTAL(CASE WHEN typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer' AND input_tokens >= 0 AND output_tokens >= 0 AND input_tokens <= 9007199254740991 AND output_tokens <= 9007199254740991 AND input_tokens + output_tokens <= 9007199254740991 THEN input_tokens + output_tokens ELSE 0 END) as total_tokens,
          SUM(CASE WHEN ambiguous = 1 OR typeof(input_tokens) != 'integer' OR typeof(output_tokens) != 'integer'
            OR input_tokens < 0 OR output_tokens < 0 OR input_tokens > 9007199254740991 OR output_tokens > 9007199254740991
            OR input_tokens + output_tokens > 9007199254740991 THEN 1 ELSE 0 END) as uncertain
        FROM (SELECT user_id,timestamp,success,input_tokens,output_tokens,CASE WHEN usage_known IS 1 THEN 0 ELSE 1 END AS ambiguous FROM usage_logs
          UNION ALL SELECT user_id,timestamp,success,input_tokens,output_tokens,0 FROM siwc_usage_logs)
        WHERE user_id = ? AND usage_utc_ms(timestamp) BETWEEN ? AND ?
      `)
      .get(userId, today.getTime(), now) as any;

    return {
      totalRequests: result.total_requests || 0,
      successRequests: result.success_requests || 0,
      totalTokens: boundedTokenTotal(result.total_tokens),
      totalTokensComplete: !result.uncertain && Number.isSafeInteger(result.total_tokens),
    };
  }

  /**
   * 계정별 오늘 통계
   */
  getAccountTodayStats(accountId: string): { totalRequests: number; successRequests: number; totalTokens: number; totalTokensComplete: boolean } {
    const db = historyDb();
    const now = Date.now();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    const result = db
      .prepare(`
        SELECT 
          COUNT(*) as total_requests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
          TOTAL(CASE WHEN typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer' AND input_tokens >= 0 AND output_tokens >= 0 AND input_tokens <= 9007199254740991 AND output_tokens <= 9007199254740991 AND input_tokens + output_tokens <= 9007199254740991 THEN input_tokens + output_tokens ELSE 0 END) as total_tokens,
          SUM(CASE WHEN usage_known IS NOT 1 OR typeof(input_tokens) != 'integer' OR typeof(output_tokens) != 'integer' OR input_tokens < 0 OR output_tokens < 0 OR input_tokens > 9007199254740991 OR output_tokens > 9007199254740991 OR input_tokens + output_tokens > 9007199254740991 THEN 1 ELSE 0 END) as uncertain
        FROM usage_logs 
        WHERE upstream_account_id = ? AND usage_utc_ms(timestamp) BETWEEN ? AND ?
      `)
      .get(accountId, today.getTime(), now) as any;

    return {
      totalRequests: result.total_requests || 0,
      successRequests: result.success_requests || 0,
      totalTokens: boundedTokenTotal(result.total_tokens),
      totalTokensComplete: !result.uncertain && Number.isSafeInteger(result.total_tokens),
    };
  }

  private rowToLog(row: any): UsageLog {
    const safeToken = (value: unknown): number | null =>
      typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    const inputTokens = safeToken(row.input_tokens);
    const outputTokens = safeToken(row.output_tokens);
    const validPair = inputTokens !== null && outputTokens !== null && Number.isSafeInteger(inputTokens + outputTokens);
    return {
      id: row.id,
      userId: row.user_id,
      upstreamAccountId: row.upstream_account_id,
      accountKind: row.account_kind ?? 'upstream',
      accountId: row.account_id ?? row.upstream_account_id,
      timestamp: new Date(row.timestamp),
      model: row.model,
      provider: row.provider,
      inputTokens: validPair ? inputTokens : null,
      outputTokens: validPair ? outputTokens : null,
      usageKnown: validPair && row.usage_known === 1n,
      success: Boolean(row.success),
      error: row.error,
      latencyMs: Number(row.latency_ms),
    };
  }
}
