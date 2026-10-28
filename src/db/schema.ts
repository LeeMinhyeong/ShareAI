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
  credentialType: 'cookie' | 'api_key' | 'session_token';
  credentials: string;  // 암호화된 자격증명
  
  // 상태
  status: 'active' | 'quota_exceeded' | 'error' | 'disabled';
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
  upstreamAccountId: string;
  
  timestamp: Date;
  model: string;
  provider: string;
  
  inputTokens: number;
  outputTokens: number;
  
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
  credential_type TEXT NOT NULL CHECK (credential_type IN ('cookie', 'api_key', 'session_token')),
  credentials TEXT NOT NULL,
  
  status TEXT NOT NULL CHECK (status IN ('active', 'quota_exceeded', 'error', 'disabled')),
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
  
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  
  success BOOLEAN NOT NULL,
  error TEXT,
  
  latency_ms INTEGER NOT NULL,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_timestamp ON usage_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_account_timestamp ON usage_logs(upstream_account_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_upstream_accounts_status ON upstream_accounts(status, provider);
`;
