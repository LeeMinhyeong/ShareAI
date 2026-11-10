/**
 * 데이터베이스 스키마 정의
 */

export interface User {
  id: string;
  apiKeyHash: string;  // SHA-256 해시
  name: string;
  email: string;
  tier: 'free' | 'pro';
  dailyLimit: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpstreamAccount {
  id: string;
  name: string;  // "Claude-A", "GPT-B"
  provider: 'anthropic' | 'openai' | 'google';
  credentialType: CredentialType;
  credentials: string;  // 복호화된 자격증명 (oauth는 JSON 문자열)
  meta: AccountMeta;    // 평문 메타정보 (이메일, 플랜, 토큰 만료)
  quotaInfo: QuotaInfo | null; // 업스트림 레이트리밋 헤더 스냅샷
  
  // 상태
  status: 'active' | 'quota_exceeded' | 'error' | 'disabled';
  stateRevision: number;
  credentialRevision: number;
  lastRefreshRevision: number;
  lastUsed: Date | null;
  lastError: string | null;
  
  // 할당량
  dailyQuota: number;  // 일일 요청 수 한도 (0 = 무제한)
  usedToday: number;
  quotaResetAt: Date;
  
  // 선택 우선순위
  priority: number;  // 낮을수록 우선 (0=최우선)
  weight: number;    // 라운드로빈 가중치
  
  createdAt: Date;
  updatedAt: Date;
}

export type CredentialType = 'cookie' | 'api_key' | 'session_token' | 'oauth';

export interface AccountMeta {
  email?: string | null;
  plan?: string | null;
  expiresAt?: number | null;   // access token 만료 (epoch ms)
  source?: string | null;      // 'oauth_login' | 'claude_credentials' | 'setup_token' | 'codex_auth_json' ...
  hasRefreshToken?: boolean;
}

export interface QuotaInfo {
  capturedAt: string;
  headers: Record<string, string>;
  resetAt?: number | null;     // 429 시 다음 사용 가능 시각 (epoch ms)
}

export interface AccountPoolRule {
  id: string;
  userId: string | null;  // null = 전체 사용자에게 적용
  provider: string | null;  // null = 모든 제공자
  modelPattern: string;  // "claude-3-*", "gpt-4*"
  
  allowedAccountIds: string[];  // JSON 배열
  selectionStrategy: 'round_robin' | 'priority' | 'least_used';
  enableFallback: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageLog {
  id: string;
  userId: string;
  upstreamAccountId: string | null;
  accountKind: 'upstream' | 'siwc';
  accountId: string;
  
  timestamp: Date;
  model: string;
  provider: string;
  
  inputTokens: number | null;
  outputTokens: number | null;
  usageKnown: boolean;
  
  success: boolean;
  error: string | null;
  
  latencyMs: number;
}

export const SQL_SCHEMA = `
-- 사용자 테이블
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  api_key_hash TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'pro')),
  daily_limit INTEGER NOT NULL DEFAULT 1000,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 업스트림 계정 테이블
CREATE TABLE IF NOT EXISTS upstream_accounts (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  credential_type TEXT NOT NULL CHECK (credential_type IN ('cookie', 'api_key', 'session_token', 'oauth')),
  credentials TEXT NOT NULL,
  meta TEXT,
  quota_info TEXT,
  
  status TEXT NOT NULL CHECK (status IN ('active', 'quota_exceeded', 'error', 'disabled')),
  state_revision INTEGER NOT NULL DEFAULT 0,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  last_refresh_revision INTEGER NOT NULL DEFAULT -1,
  last_used TIMESTAMP,
  last_error TEXT,
  
  daily_quota INTEGER NOT NULL DEFAULT 0,
  used_today INTEGER NOT NULL DEFAULT 0,
  quota_reset_at TIMESTAMP NOT NULL,
  
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 계정 풀 규칙 테이블
CREATE TABLE IF NOT EXISTS account_pool_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  provider TEXT,
  model_pattern TEXT NOT NULL,
  
  allowed_account_ids TEXT NOT NULL,
  selection_strategy TEXT NOT NULL CHECK (selection_strategy IN ('round_robin', 'priority', 'least_used')),
  enable_fallback BOOLEAN NOT NULL DEFAULT TRUE,
  
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 사용 로그 테이블
CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  upstream_account_id TEXT NOT NULL,
  
  timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  
  input_tokens INTEGER,
  output_tokens INTEGER,
  usage_known INTEGER CHECK (usage_known IS NULL OR usage_known IN (0, 1)),
  
  success BOOLEAN NOT NULL,
  error TEXT,
  
  latency_ms INTEGER NOT NULL,

  CHECK ((input_tokens IS NULL AND output_tokens IS NULL AND usage_known IS 0) OR
    (typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer' AND input_tokens >= 0 AND output_tokens >= 0 AND input_tokens <= 9007199254740991 AND output_tokens <= 9007199254740991 AND input_tokens + output_tokens <= 9007199254740991 AND usage_known IS 1) OR
    (usage_known IS NULL AND typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer')),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE
);

-- 설정 (라우팅 전략 등)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_timestamp ON usage_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_account_timestamp ON usage_logs(upstream_account_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_upstream_accounts_status ON upstream_accounts(status, provider);
`;

/** Fail closed until the explicitly offline legacy-history migration exists. */
export function assertTokenUsageSchema(db: import('better-sqlite3').Database, allowAbsent = false): void {
  const unsafe = (): never => { throw new Error('Incompatible usage_logs schema; offline token-usage migration is not yet available'); };
  if (db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name = 'usage_logs' COLLATE NOCASE").get()) unsafe();
  const actual = db.prepare("SELECT type, name, sql FROM main.sqlite_schema WHERE name = 'usage_logs' COLLATE NOCASE").get() as {type:string;name:string;sql:string} | undefined;
  if (!actual) {
    // Provisioning may precede the application schema, but an established
    // application database with missing history must not silently recreate it.
    if (allowAbsent && !db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('users','upstream_accounts')").get()) return;
    return unsafe();
  }
  const expected = SQL_SCHEMA.match(/CREATE TABLE IF NOT EXISTS usage_logs \([\s\S]*?\n\);/)?.[0].replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE').replace(/;$/, '');
  const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (!expected || actual.type !== 'table' || actual.name !== 'usage_logs' || !actual.sql || normalized(actual.sql) !== normalized(expected)) unsafe();
}

