/**
 * 구독 계정 OAuth (Claude Pro/Max = Claude Code OAuth, ChatGPT Plus/Pro = Codex OAuth)
 *
 * 엔드포인트/client_id/파라미터는 OmniRoute 소스에서 확인한 값:
 *  - omniroute-source/src/lib/oauth/constants/oauth.ts  (CLAUDE_CONFIG, CODEX_CONFIG)
 *  - omniroute-source/src/lib/oauth/providers/{claude,codex}.ts  (PKCE, token exchange)
 *  - omniroute-source/open-sse/services/tokenRefresh/providers/{claudeOAuth,codex}.ts (refresh)
 *  - client_id 는 open-sse/utils/publicCreds.ts 에서 복호화해 확인
 */
import crypto from 'crypto';
import http from 'http';
import { logger } from '../utils/logger.js';
import type { AccountMeta } from '../db/schema.js';

export type OAuthProvider = 'anthropic' | 'openai';

export const CLAUDE_OAUTH = {
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'],
};

export const CODEX_OAUTH = {
  clientId: process.env.CODEX_OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  callbackPort: 1455,
  callbackPath: '/auth/callback',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
};

/** DB credentials 컬럼에 (암호화되어) 저장되는 OAuth 자격증명 */
export interface OAuthCredentials {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null; // epoch ms
  idToken?: string | null;
  accountId?: string | null; // ChatGPT workspace (chatgpt-account-id)
}

export interface ParsedCredential {
  credentialType: 'oauth' | 'api_key';
  credentials: string; // DB에 저장할 문자열
  meta: AccountMeta;
}

// ---------------------------------------------------------------------------
// JWT / 유틸
// ---------------------------------------------------------------------------

export function decodeJwt(token: string | null | undefined): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function toMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v; // 초 단위면 ms 로
}

function codexIdentity(idToken?: string | null, accessToken?: string | null) {
  const id = decodeJwt(idToken) ?? {};
  const access = decodeJwt(accessToken) ?? {};
  const auth = id['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth'] ?? {};
  return {
    email: (id.email ?? access['https://api.openai.com/profile']?.email ?? null) as string | null,
    plan: (auth.chatgpt_plan_type ?? null) as string | null,
    accountId: (auth.chatgpt_account_id ?? null) as string | null,
    expiresAt: toMs(access.exp),
  };
}

export function parseStoredCredentials(raw: string): OAuthCredentials | null {
  if (!raw || raw[0] !== '{') return null;
  try {
    const obj = JSON.parse(raw);
    return obj?.kind === 'oauth' && typeof obj.accessToken === 'string' ? obj : null;
  } catch {
    return null;
  }
}

function build(creds: OAuthCredentials, meta: AccountMeta): ParsedCredential {
  return {
    credentialType: 'oauth',
    credentials: JSON.stringify(creds),
    meta: { ...meta, expiresAt: creds.expiresAt ?? null, hasRefreshToken: !!creds.refreshToken },
  };
}

// ---------------------------------------------------------------------------
// 가져오기 (붙여넣기) — 가장 간단한 등록 방법
// ---------------------------------------------------------------------------

/**
 * 사용자가 붙여넣은 텍스트를 자격증명으로 변환.
 *  Claude:
 *   - ~/.claude/.credentials.json 내용   {"claudeAiOauth":{accessToken,refreshToken,expiresAt,subscriptionType}}
 *   - `claude setup-token` 결과           sk-ant-oat01-...   (1년 유효, 갱신 불필요)
 *   - Anthropic API 키                    sk-ant-api03-...
 *  ChatGPT:
 *   - ~/.codex/auth.json 내용             {"tokens":{id_token,access_token,refresh_token,account_id}}
 *   - OpenAI API 키                       sk-...
 */
export function parseImportedCredential(provider: OAuthProvider, input: string): ParsedCredential {
  const text = (input || '').trim();
  if (!text) throw new Error('자격증명이 비어 있습니다.');

  if (provider === 'anthropic') {
    if (text.startsWith('sk-ant-api')) {
      return { credentialType: 'api_key', credentials: text, meta: { source: 'api_key' } };
    }
    if (text.startsWith('sk-ant-oat')) {
      return build({ kind: 'oauth', accessToken: text, refreshToken: null, expiresAt: null }, { source: 'setup_token' });
    }
    const obj = tryJson(text);
    const o = obj?.claudeAiOauth ?? obj;
    if (o && typeof o.accessToken === 'string') {
      return build(
        {
          kind: 'oauth',
          accessToken: o.accessToken,
          refreshToken: o.refreshToken ?? null,
          expiresAt: toMs(o.expiresAt),
        },
        { source: 'claude_credentials', plan: o.subscriptionType ?? null }
      );
    }
    throw new Error(
      'Claude 자격증명 형식을 인식하지 못했습니다. ~/.claude/.credentials.json 내용, `claude setup-token` 토큰(sk-ant-oat...), 또는 API 키를 넣어주세요.'
    );
  }

  // openai
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(text)) {
    return { credentialType: 'api_key', credentials: text, meta: { source: 'api_key' } };
  }
  const obj = tryJson(text);
  const t = obj?.tokens ?? obj;
  const access = t?.access_token ?? t?.accessToken;
  if (typeof access === 'string') {
    const idToken = t.id_token ?? t.idToken ?? null;
    const ident = codexIdentity(idToken, access);
    return build(
      {
        kind: 'oauth',
        accessToken: access,
        refreshToken: t.refresh_token ?? t.refreshToken ?? null,
        idToken,
        accountId: t.account_id ?? t.accountId ?? ident.accountId,
        expiresAt: ident.expiresAt,
      },
      { source: 'codex_auth_json', email: ident.email, plan: ident.plan }
    );
  }
  if (text.split('.').length === 3) {
    const ident = codexIdentity(null, text);
    return build(
      { kind: 'oauth', accessToken: text, refreshToken: null, accountId: ident.accountId, expiresAt: ident.expiresAt },
      { source: 'access_token', email: ident.email, plan: ident.plan }
    );
  }
  throw new Error(
    'ChatGPT 자격증명 형식을 인식하지 못했습니다. ~/.codex/auth.json 내용 또는 API 키를 넣어주세요.'
  );
}

function tryJson(text: string): any {
  if (text[0] !== '{') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSON 형식이 올바르지 않습니다. 파일 내용을 전부 복사했는지 확인해주세요.');
  }
}

// ---------------------------------------------------------------------------
// 토큰 갱신
// ---------------------------------------------------------------------------

export class RefreshError extends Error {
  constructor(message: string, public unrecoverable: boolean) {
    super(message);
  }
}

export async function refreshTokens(provider: OAuthProvider, creds: OAuthCredentials): Promise<OAuthCredentials> {
  if (!creds.refreshToken) throw new RefreshError('refresh token 없음 (재로그인 필요)', true);

  const isClaude = provider === 'anthropic';
  const res = await fetch(isClaude ? CLAUDE_OAUTH.tokenUrl : CODEX_OAUTH.tokenUrl, {
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...(isClaude ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
    },
    // Codex: scope 를 보내지 않음 (보내면 같은 client_id 의 다른 계정 refresh token 이 무효화될 수 있음 — OmniRoute 주석)
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: isClaude ? CLAUDE_OAUTH.clientId : CODEX_OAUTH.clientId,
    }).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    let code = '';
    try {
      const j = JSON.parse(text);
      code = j?.error?.code ?? (typeof j?.error === 'string' ? j.error : '');
    } catch {
      /* not json */
    }
    const unrecoverable =
      res.status === 401 || ['invalid_grant', 'invalid_request', 'refresh_token_reused', 'token_expired', 'invalid_token'].includes(code);
    throw new RefreshError(`토큰 갱신 실패 (${res.status})`, unrecoverable);
  }

  let j: any;
  try { j = JSON.parse(text); }
  catch { throw new RefreshError('토큰 응답이 올바르지 않습니다.', false); }
  // Bearer credentials must be safe in an Authorization header (RFC 6750 b64token).
  if (typeof j?.access_token !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(j.access_token)) {
    throw new RefreshError('토큰 응답이 올바르지 않습니다.', false);
  }
  const has = (key: string) => Object.prototype.hasOwnProperty.call(j, key);
  // Some providers omit token_type; accept omission for compatibility, but
  // an explicitly supplied value must identify Bearer case-insensitively.
  if (has('token_type') && (typeof j.token_type !== 'string' || !/^Bearer$/i.test(j.token_type))) {
    throw new RefreshError('토큰 응답이 올바르지 않습니다.', false);
  }
  const nonempty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if ((has('refresh_token') && !nonempty(j.refresh_token)) ||
      (has('id_token') && !nonempty(j.id_token)) ||
      (has('expires_in') && (typeof j.expires_in !== 'number' || !Number.isFinite(j.expires_in) || j.expires_in <= 0 || !Number.isSafeInteger(Date.now() + j.expires_in * 1000)))) {
    throw new RefreshError('토큰 응답이 올바르지 않습니다.', false);
  }
  const next: OAuthCredentials = {
    ...creds,
    accessToken: j.access_token,
    // Omission can mean the provider retained the old token, but it might have
    // consumed it. Never automatically reuse a token after an uncertain rotation.
    refreshToken: has('refresh_token') ? j.refresh_token : null,
    expiresAt: has('expires_in') ? Date.now() + j.expires_in * 1000 : null,
  };
  if (!isClaude) {
    if (has('id_token')) next.idToken = j.id_token;
    const ident = codexIdentity(next.idToken, next.accessToken);
    next.accountId = next.accountId || ident.accountId;
    if (!has('expires_in')) next.expiresAt = ident.expiresAt;
  }
  return next;
}

// ---------------------------------------------------------------------------
// 브라우저 로그인 (PKCE)
// ---------------------------------------------------------------------------

export interface PendingAccountParams {
  name: string;
  priority?: number;
  weight?: number;
  dailyQuota?: number;
}

interface LoginFlow {
  id: string;
  provider: OAuthProvider;
  verifier: string;
  state: string;
  createdAt: number;
  params: PendingAccountParams;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
  accountId?: string;
}

const FLOW_TTL_MS = 10 * 60 * 1000;
const flows = new Map<string, LoginFlow>();
let callbackServer: http.Server | null = null;
let callbackStarting: Promise<boolean> | null = null;
let callbackClosing: Promise<void> | null = null;
let closingServer: http.Server | null = null;
let oauthStopping = false;
const oauthOperations = new Set<Promise<void>>();
const oauthAbort = new AbortController();

function closeCallbackServer(): void {
  if (!callbackServer) return;
  const server = callbackServer;
  callbackServer = null;
  closingServer = server;
  callbackClosing = new Promise<void>(resolve => server.close(() => resolve())).finally(() => {
    closingServer = null;
    callbackClosing = null;
  });
}

export function stopOAuth(): Promise<void> {
  oauthStopping = true;
  oauthAbort.abort();
  flows.clear();
  onTokens = null;
  closeCallbackServer();
  closingServer?.closeAllConnections();
  return Promise.allSettled([...oauthOperations]).then(() => undefined);
}

/** 로그인 완료 시 계정 생성 콜백 (routes/admin 에서 주입) */
type OnTokens = (flow: LoginFlow, parsed: ParsedCredential) => Promise<string>;
let onTokens: OnTokens | null = null;
export function setOnLoginComplete(fn: OnTokens) {
  onTokens = fn;
}

function b64url(buf: Buffer) {
  return buf.toString('base64url');
}

function cleanupFlows() {
  const now = Date.now();
  for (const [id, f] of flows) if (now - f.createdAt >= FLOW_TTL_MS) flows.delete(id);
  const hasPendingCodex = [...flows.values()].some(f => f.provider === 'openai' && (f.status === 'pending' || f.status === 'processing'));
  if (!hasPendingCodex) closeCallbackServer();
}

export async function startLogin(provider: OAuthProvider, params: PendingAccountParams) {
  if (oauthStopping) throw new Error('OAuth is shutting down');
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error('지원하지 않는 제공자입니다.');
  cleanupFlows();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  const flow: LoginFlow = {
    id: crypto.randomUUID(),
    provider,
    verifier,
    state,
    createdAt: Date.now(),
    params,
    status: 'pending',
  };
  flows.set(flow.id, flow);
  const timer = setTimeout(cleanupFlows, FLOW_TTL_MS + 1);
  timer.unref();

  let authUrl: string;
  let callbackListening = false;
  if (provider === 'anthropic') {
    const q = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_OAUTH.clientId,
      response_type: 'code',
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      scope: CLAUDE_OAUTH.scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      // 여러 계정을 같은 브라우저에서 로그인할 때 이전 계정 세션을 재사용하지 않도록 강제 재로그인
      prompt: 'login',
    });
    authUrl = `${CLAUDE_OAUTH.authorizeUrl}?${q.toString()}`;
  } else {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_OAUTH.clientId,
      redirect_uri: CODEX_OAUTH.redirectUri,
      scope: CODEX_OAUTH.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
      prompt: 'login',
      state,
    });
    authUrl = `${CODEX_OAUTH.authorizeUrl}?${q.toString()}`;
    callbackListening = await ensureCodexCallbackServer();
  }

  return { flowId: flow.id, authUrl, callbackListening };
}

export function getFlow(flowId: string) {
  cleanupFlows();
  const f = flows.get(flowId);
  if (!f) return null;
  return { id: f.id, provider: f.provider, status: f.status, error: f.error, accountId: f.accountId };
}

/**
 * 사용자가 붙여넣은 코드로 로그인 완료.
 *  Claude: 로그인 후 화면에 표시되는 "code#state" 문자열
 *  ChatGPT: 자동 콜백이 실패했을 때 주소창의 http://localhost:1455/auth/callback?code=... URL 전체
 */
export async function finishLogin(flowId: string, input: string) {
  cleanupFlows();
  const flow = flows.get(flowId);
  if (!flow) throw new Error('로그인 세션이 만료되었거나 없습니다. 처음부터 다시 시도해주세요.');
  if (flow.status !== 'pending') throw new Error('로그인 세션이 이미 사용 중이거나 종료되었습니다.');

  let code = (input || '').trim();
  let state = '';
  if (code.startsWith('http')) {
    const u = new URL(code);
    code = u.searchParams.get('code') || '';
    if (flow.provider !== 'openai' || u.origin !== 'http://localhost:1455' || u.pathname !== CODEX_OAUTH.callbackPath) throw new Error('잘못된 콜백 URL입니다.');
    state = u.searchParams.get('state') || '';
  } else if (code.includes('#')) {
    const [c, s] = code.split('#');
    code = c;
    state = s || '';
  }
  if (!code) throw new Error('코드를 찾지 못했습니다.');
  if (state !== flow.state) throw new Error('state 값이 일치하지 않습니다. 이 로그인 세션에서 받은 코드인지 확인해주세요.');

  await completeFlow(flow, code);
  return getFlow(flowId)!;
}

function completeFlow(flow: LoginFlow, code: string): Promise<void> {
  if (oauthStopping) return Promise.reject(new Error('OAuth is shutting down'));
  const operation = runCompleteFlow(flow, code);
  oauthOperations.add(operation);
  void operation.then(() => oauthOperations.delete(operation), () => oauthOperations.delete(operation));
  return operation;
}

async function runCompleteFlow(flow: LoginFlow, code: string) {
  cleanupFlows();
  if (flows.get(flow.id) !== flow || flow.status !== 'pending') throw new Error('로그인 세션이 만료되었거나 이미 사용되었습니다.');
  flow.status = 'processing';
  try {
    const parsed = flow.provider === 'anthropic' ? await exchangeClaude(flow, code) : await exchangeCodex(flow, code);
    if (oauthStopping || flows.get(flow.id) !== flow || Date.now() - flow.createdAt >= FLOW_TTL_MS) throw new Error('로그인 세션이 만료되었습니다.');
    if (!onTokens) throw new Error('login handler not registered');
    flow.accountId = await onTokens(flow, parsed);
    flow.status = 'done';
  } catch (e: any) {
    flow.status = 'error';
    flow.error = '로그인을 완료하지 못했습니다. 다시 시도해주세요.';
    throw new Error(flow.error);
  } finally {
    cleanupFlows();
  }
}

async function exchangeClaude(flow: LoginFlow, code: string): Promise<ParsedCredential> {
  const res = await fetch(CLAUDE_OAUTH.tokenUrl, {
    signal: AbortSignal.any([oauthAbort.signal, AbortSignal.timeout(10_000)]),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code,
      state: flow.state,
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH.clientId,
      redirect_uri: CLAUDE_OAUTH.redirectUri,
      code_verifier: flow.verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Claude 토큰 교환 실패 (${res.status})`);
  const t = JSON.parse(text);
  if (typeof t.access_token !== 'string' || !t.access_token) throw new Error('토큰 응답이 올바르지 않습니다.');

  // 이메일/플랜 조회 (실패해도 무시)
  let email: string | null = t.account?.email_address ?? null;
  let plan: string | null = null;
  try {
    const bs = await fetch('https://api.anthropic.com/api/claude_cli/bootstrap', {
      headers: { Authorization: `Bearer ${t.access_token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: AbortSignal.any([oauthAbort.signal, AbortSignal.timeout(10_000)]),
    });
    if (bs.ok) {
      const d: any = await bs.json();
      email = d?.oauth_account?.account_email ?? email;
      plan = d?.oauth_account?.organization_rate_limit_tier ?? d?.oauth_account?.organization_type ?? null;
    }
  } catch {
    /* best effort */
  }

  return build(
    {
      kind: 'oauth',
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    },
    { source: 'oauth_login', email, plan }
  );
}

async function exchangeCodex(flow: LoginFlow, code: string): Promise<ParsedCredential> {
  const res = await fetch(CODEX_OAUTH.tokenUrl, {
    signal: AbortSignal.any([oauthAbort.signal, AbortSignal.timeout(10_000)]),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH.clientId,
      code,
      redirect_uri: CODEX_OAUTH.redirectUri,
      code_verifier: flow.verifier,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ChatGPT 토큰 교환 실패 (${res.status})`);
  const t = JSON.parse(text);
  if (typeof t.access_token !== 'string' || !t.access_token) throw new Error('토큰 응답이 올바르지 않습니다.');
  const ident = codexIdentity(t.id_token, t.access_token);
  return build(
    {
      kind: 'oauth',
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      idToken: t.id_token ?? null,
      accountId: ident.accountId,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : ident.expiresAt,
    },
    { source: 'oauth_login', email: ident.email, plan: ident.plan }
  );
}

/**
 * Codex OAuth 는 redirect_uri 가 http://localhost:1455/auth/callback 으로 고정.
 * 로그인 대기 중에만 1455 포트에서 콜백을 받는다.
 * (브라우저가 서버와 다른 PC라면 콜백이 안 오므로 주소창 URL 붙여넣기로 완료)
 */
function ensureCodexCallbackServer(): Promise<boolean> {
  if (oauthStopping) return Promise.resolve(false);
  if (callbackClosing) return callbackClosing.then(() => ensureCodexCallbackServer());
  if (callbackServer) return Promise.resolve(true);
  if (callbackStarting) return callbackStarting;
  callbackStarting = new Promise<boolean>(resolve => {
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      const url = new URL(req.url || '/', `http://localhost:${CODEX_OAUTH.callbackPort}`);
      if (url.pathname !== CODEX_OAUTH.callbackPath) {
        res.writeHead(404).end();
        return;
      }
      cleanupFlows();
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const flow = [...flows.values()].find(f => f.state === state && f.provider === 'openai' && f.status === 'pending');
      const page = (title: string, msg: string) =>
        `<!doctype html><meta charset="utf-8"><title>ShareAI</title><body style="font-family:sans-serif;padding:40px"><h2>${title}</h2><p>${msg}</p></body>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!flow || !code) {
        res.writeHead(400).end(page('로그인 실패', '로그인 세션을 찾지 못했습니다. 대시보드에서 다시 시도해주세요.'));
        return;
      }
      try {
        await completeFlow(flow, code);
        res.writeHead(200).end(page('✅ ChatGPT 계정 연결 완료', '이 창을 닫고 ShareAI 대시보드로 돌아가세요.'));
      } catch (e: any) {
        res.writeHead(500).end(page('로그인 실패', '로그인을 완료하지 못했습니다. 대시보드에서 다시 시도해주세요.'));
      }
    });
    server.once('error', err => {
      logger.warn({ err }, `Codex OAuth callback port ${CODEX_OAUTH.callbackPort} unavailable`);
      resolve(false);
    });
    server.listen(CODEX_OAUTH.callbackPort, '127.0.0.1', () => {
      if (oauthStopping) {
        server.close();
        server.closeAllConnections();
        resolve(false);
        return;
      }
      callbackServer = server;
      logger.info(`Codex OAuth callback listening on :${CODEX_OAUTH.callbackPort}`);
      resolve(true);
    });
  }).finally(() => { callbackStarting = null; });
  return callbackStarting;
}
