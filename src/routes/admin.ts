/**
 * /admin API 라우트 (관리자 전용)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateAdmin } from '../auth/user-auth.js';
import { requestWork } from '../request-work.js';
import { UserRepository } from '../db/repositories/users.js';
import { AccountRepository } from '../db/repositories/accounts.js';
import { UsageLogRepository } from '../db/repositories/usage-logs.js';
import { generateApiKey, hashApiKey } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { startLogin, finishLogin, getFlow, setOnLoginComplete, parseImportedCredential, type OAuthProvider } from '../upstream/oauth.js';

import { SettingsRepository, STRATEGIES } from '../db/repositories/settings.js';
import { createSiwcRouter } from '../upstream/siwc-login.js';
import { routingSnapshot } from './routing-snapshot.js';

const router = Router();
const siwcRouter = createSiwcRouter(authenticateAdmin);
router.use('/accounts/siwc', siwcRouter);
router.use('/siwc', siwcRouter);
const userRepo = new UserRepository();
const accountRepo = new AccountRepository();
const usageRepo = new UsageLogRepository();
const settingsRepo = new SettingsRepository();

setOnLoginComplete(async (flow, parsed) => accountRepo.create({
  ...flow.params, provider: flow.provider, credentialType: parsed.credentialType,
  credentials: parsed.credentials, meta: parsed.meta,
}).id);

function validRoutingValues(priority: unknown, weight: unknown): boolean {
  return (priority === undefined || (Number.isSafeInteger(priority) && (priority as number) >= 0)) &&
    (weight === undefined || (Number.isSafeInteger(weight) && (weight as number) >= 1));
}

function onboardingParams(body: any) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 ||
      !['anthropic', 'openai'].includes(body.provider) ||
      (body.dailyQuota !== undefined && (!Number.isSafeInteger(body.dailyQuota) || body.dailyQuota < 0)) ||
      !validRoutingValues(body.priority, body.weight)) return null;
  return { name: body.name.trim(), provider: body.provider as OAuthProvider, dailyQuota: body.dailyQuota, priority: body.priority, weight: body.weight };
}

router.post('/accounts/oauth/start', authenticateAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const params = onboardingParams(req.body);
  if (!params) return res.status(400).json({ error: { message: 'Invalid account parameters' } });
  try { return res.json(await startLogin(params.provider, params)); }
  catch { return res.status(500).json({ error: { message: 'Could not start login' } }); }
});

router.get('/accounts/oauth/:flowId', authenticateAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const flow = getFlow(req.params.flowId);
  if (!flow) return res.status(404).json({ error: { message: 'Login session not found or expired' } });
  return res.json(flow);
});

router.post('/accounts/oauth/:flowId/finish', authenticateAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (typeof req.body?.code !== 'string' || !req.body.code || req.body.code.length > 8192)
    return res.status(400).json({ error: { message: 'Invalid authorization response' } });
  try { return res.json(await finishLogin(req.params.flowId, req.body.code)); }
  catch { return res.status(400).json({ error: { message: 'Login failed; check the session and authorization response' } }); }
});

router.post('/accounts/import', authenticateAdmin, (req, res) => ownedSyncUserRoute(res, (responding) => {
  res.set('Cache-Control', 'no-store');
  const params = onboardingParams(req.body);
  if (!params || typeof req.body?.credentials !== 'string' || !req.body.credentials || req.body.credentials.length > 65536) {
    responding();
    return res.status(400).json({ error: { message: 'Invalid account parameters or credentials' } });
  }
  let account;
  try {
    const parsed = parseImportedCredential(params.provider, req.body.credentials);
    account = accountRepo.create({ ...params, ...parsed });
  } catch {
    responding();
    return res.status(400).json({ error: { message: 'Could not import credentials' } });
  }
  const payload = { account: { id: account.id, name: account.name, provider: account.provider, credentialType: account.credentialType, status: account.status } };
  responding();
  return res.status(201).json(payload);
}, 'account'));

/**
 * POST /admin/users
 * 사용자 생성
 */
router.post('/users', authenticateAdmin, (req: Request, res: Response) => {
  // This handler and UserRepository.create are synchronous; no work is detached.
  const admitted = requestWork.ownedDispatch(scope => {
    try { createUser(req, res); }
    finally { scope.terminal(); }
  });
  if (!admitted) {
    try { res.status(503).json({ error: { type: 'service_unavailable', message: 'Server is shutting down.' } }); }
    catch {
      try { if (!res.writableEnded) res.destroy(); } catch { /* Best-effort termination. */ }
    }
  }
});

function createUser(req: Request, res: Response): void {
  let responding = false;
  try {
    res.set('Cache-Control', 'no-store');
    const { name, email, tier = 'free', dailyLimit = 100 } = req.body;

    if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || req.body.enabled !== undefined) {
      responding = true;
      res.status(400).json({ error: { type: 'invalid_request', message: 'Invalid dailyLimit or unsupported enabled field' } });
      return;
    }

    if (!name || !email) {
      responding = true;
      res.status(400).json({
        error: {
          type: 'invalid_request',
          message: 'Missing required fields: name, email',
        },
      });
      return;
    }

    // API 키 생성
    const apiKey = generateApiKey('user');
    const apiKeyHash = hashApiKey(apiKey);

    const user = userRepo.create({
      apiKeyHash,
      name,
      email,
      tier,
      dailyLimit,
    });

    logger.info({ userId: user.id, email: user.email }, 'User created');

    responding = true;
    res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        dailyLimit: user.dailyLimit,
        enabled: user.enabled,
        createdAt: user.createdAt,
      },
      apiKey, // ⚠️ 한 번만 표시됨
    });
  } catch {
    try { logger.error('Failed to create user'); } catch { /* Logging must not escape. */ }
    try {
      if (!responding && !res.headersSent) {
        res.status(500).json({ error: { type: 'internal_error', message: 'Failed to create user' } });
        return;
      }
    } catch { /* Response failed; do not forward the thrown value to Express. */ }
    try { if (!res.writableEnded) res.destroy(); } catch { /* Best-effort termination. */ }
  }
}

// Only synchronous terminal handlers with no detached work may use this wrapper.
function ownedSyncUserRoute(res: Response, handler: (responding: () => void) => void, kind: 'user' | 'account' | 'settings' | 'stats' = 'user'): void {
  const message = kind === 'stats' ? 'Failed to process admin stats request' : kind === 'settings' ? 'Failed to process admin settings request' : kind === 'account' ? 'Failed to process admin account request' : 'Failed to process admin user request';
  let responding = false;
  const destroy = () => {
    let ended = false;
    try { ended = res.writableEnded; } catch { /* Still attempt destruction. */ }
    if (!ended) try { res.destroy(); } catch { /* Best effort. */ }
  };
  try {
    const admitted = requestWork.ownedDispatch(scope => {
      try {
        try { handler(() => { responding = true; }); }
        catch {
          try { logger.error(message); } catch { /* Best effort. */ }
          try {
            if (!responding && !res.headersSent) {
              responding = true;
              res.status(500).json({ error: { type: 'internal_error', message } });
              return;
            }
          } catch { /* Response state or delivery failed. */ }
          destroy();
        }
      } finally { scope.terminal(); }
    });
    if (!admitted) {
      try { res.status(503).json({ error: { type: 'service_unavailable', message: 'Server is shutting down.' } }); }
      catch { destroy(); }
    }
  } catch { destroy(); }
}

/**
 * GET /admin/users
 * 사용자 목록
 */
router.get('/users', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
    const users = userRepo.findAll();

    const payload = {
      users: users.map(user => ({
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        dailyLimit: user.dailyLimit,
        enabled: user.enabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
    };
    responding(); res.json(payload);
}));

/**
 * GET /admin/users/:id
 * 사용자 상세 (사용량 포함)
 */
router.get('/users/:id', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
    const { id } = req.params;
    const user = userRepo.findById(id);

    if (!user) {
      responding(); res.status(404).json({
        error: {
          type: 'not_found',
          message: 'User not found',
        },
      });
      return;
    }

    const todayStats = usageRepo.getTodayStats(id);
    const recentLogs = usageRepo.findByUser(id, 20);

    const payload = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        tier: user.tier,
        dailyLimit: user.dailyLimit,
        enabled: user.enabled,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      todayStats,
      recentLogs: recentLogs.map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        model: log.model,
        provider: log.provider,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        usageKnown: log.usageKnown,
        success: log.success,
        error: log.error,
        latencyMs: log.latencyMs,
      })),
    };
    responding(); res.json(payload);
}));

/**
 * PATCH /admin/users/:id
 * 사용자 수정
 */
router.patch('/users/:id', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
    const { id } = req.params;
    const { name, email, tier, dailyLimit, enabled } = req.body;

    if ((dailyLimit !== undefined && (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0)) ||
        (enabled !== undefined && typeof enabled !== 'boolean')) {
      responding(); res.status(400).json({ error: { type: 'invalid_request', message: 'Invalid dailyLimit or enabled' } });
      return;
    }

    const user = userRepo.findById(id);
    if (!user) {
      responding(); res.status(404).json({
        error: {
          type: 'not_found',
          message: 'User not found',
        },
      });
      return;
    }

    userRepo.update(id, { name, email, tier, dailyLimit, enabled });

    logger.info({ userId: id }, 'User updated');

    const updated = userRepo.findById(id)!;
    const payload = {
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        tier: updated.tier,
        dailyLimit: updated.dailyLimit,
        enabled: updated.enabled,
        updatedAt: updated.updatedAt,
      },
    };
    responding(); res.json(payload);
}));

/**
 * POST /admin/accounts
 * 계정 생성
 */
router.post('/accounts', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
    const { name, provider, credentialType, credentials, dailyQuota = 0, priority = 0, weight = 1 } = req.body;

    if (!validRoutingValues(priority, weight)) {
      responding(); res.status(400).json({ error: { type: 'invalid_request', message: 'Invalid priority or weight' } });
      return;
    }

    if (!name || !provider || !credentialType || !credentials) {
      responding(); res.status(400).json({
        error: {
          type: 'invalid_request',
          message: 'Missing required fields: name, provider, credentialType, credentials',
        },
      });
      return;
    }

    const account = accountRepo.create({
      name,
      provider,
      credentialType,
      credentials,
      dailyQuota,
      priority,
      weight,
    });

    logger.info({ accountId: account.id, name: account.name, provider: account.provider }, 'Account created');

    const payload = {
      account: {
        id: account.id,
        name: account.name,
        provider: account.provider,
        credentialType: account.credentialType,
        status: account.status,
        dailyQuota: account.dailyQuota,
        usedToday: account.usedToday,
        priority: account.priority,
        weight: account.weight,
        createdAt: account.createdAt,
      },
    };
    responding(); res.status(201).json(payload);
}, 'account'));

export function routingSnapshotNoStore(_req: Request, res: Response, next: () => void): void {
  res.set('Cache-Control', 'no-store');
  next();
}

router.get('/routing-snapshot', routingSnapshotNoStore, authenticateAdmin, (_req, res) => {
  const terminate = () => {
    try { if (!res.destroyed && !res.writableEnded) res.destroy(); }
    catch { try { res.destroy(); } catch { /* Best-effort termination. */ } }
  };
  const unavailable = (message: string) => {
    try {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { terminate(); return; }
      res.status(503).json({ error: { type: 'service_unavailable', message } });
    } catch { terminate(); }
  };
  const admitted = requestWork.ownedDispatch(scope => {
    try {
      let snapshot: ReturnType<typeof routingSnapshot>;
      try { snapshot = routingSnapshot(); }
      catch { unavailable('Routing snapshot unavailable'); return; }
      try { res.json(snapshot); } catch { terminate(); }
    } finally { scope.terminal(); }
  });
  if (!admitted) unavailable('Server is shutting down.');
});

/**
 * GET /admin/accounts
 * 계정 목록
 */
router.get('/accounts', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
    const accounts = accountRepo.findAllAdmin();

    const payload = {
      accounts: accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        provider: acc.provider,
        credentialType: acc.credentialType,
        credentialStatus: acc.credentialStatus,
        status: acc.status,
        lastUsed: acc.lastUsed,
        lastError: acc.lastError,
        dailyQuota: acc.dailyQuota,
        usedToday: acc.usedToday,
        quotaResetAt: acc.quotaResetAt,
        priority: acc.priority,
        weight: acc.weight,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      })),
    };
    responding(); res.json(payload);
}, 'account'));

/**
 * GET /admin/accounts/:id
 * 계정 상세 (사용량 포함)
 */
router.get('/accounts/:id', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
  let responseStarted = false;
  const markResponse = () => { responseStarted = true; responding(); };
  try {
    const { id } = req.params;
    const account = accountRepo.findByIdAdmin(id);

    if (!account) {
      markResponse();
      res.status(404).json({
        error: {
          type: 'not_found',
          message: 'Account not found',
        },
      });
      return;
    }

    const todayStats = usageRepo.getAccountTodayStats(id);
    const recentLogs = usageRepo.findByAccount(id, 20);

    const payload = {
      account: {
        id: account.id,
        name: account.name,
        provider: account.provider,
        credentialType: account.credentialType,
        // credentials는 보안상 노출하지 않음
        credentialStatus: account.credentialStatus,
        status: account.status,
        lastUsed: account.lastUsed,
        lastError: account.lastError,
        dailyQuota: account.dailyQuota,
        usedToday: account.usedToday,
        quotaResetAt: account.quotaResetAt,
        priority: account.priority,
        weight: account.weight,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      },
      todayStats,
      recentLogs: recentLogs.map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        userId: log.userId,
        model: log.model,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        usageKnown: log.usageKnown,
        success: log.success,
        latencyMs: log.latencyMs,
      })),
    };
    markResponse();
    res.json(payload);
  } catch (error: any) {
    if (responseStarted) throw error;
    logger.error({ error }, 'Failed to get account details');
    const payload = {
      error: {
        type: 'internal_error',
        message: error.message,
      },
    };
    markResponse();
    res.status(500).json(payload);
  }
}, 'account'));

/**
 * PATCH /admin/accounts/:id
 * 계정 수정
 */
router.patch('/accounts/:id', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
  let responseStarted = false;
  const markResponse = () => { responseStarted = true; responding(); };
  try {
    const { id } = req.params;
    const { name, status, dailyQuota, priority, weight, credentials } = req.body;

    if (!validRoutingValues(priority, weight)) {
      markResponse();
      res.status(400).json({ error: { type: 'invalid_request', message: 'Invalid priority or weight' } });
      return;
    }

    const account = accountRepo.findByIdAdmin(id);
    if (!account) {
      markResponse();
      res.status(404).json({
        error: {
          type: 'not_found',
          message: 'Account not found',
        },
      });
      return;
    }

    // ADR 0020: re-enabling a non-active account goes through reactivate(), which
    // applies the other fields, clears the stale error text and starts a new state
    // generation in one transaction.
    if (status === 'active' && account.status !== 'active') accountRepo.reactivate(id, { name, dailyQuota, priority, weight, credentials });
    else accountRepo.update(id, { name, status, dailyQuota, priority, weight, credentials });

    logger.info({ accountId: id }, 'Account updated');

    const updated = accountRepo.findByIdAdmin(id)!;
    const payload = {
      account: {
        id: updated.id,
        name: updated.name,
        provider: updated.provider,
        credentialStatus: updated.credentialStatus,
        status: updated.status,
        dailyQuota: updated.dailyQuota,
        priority: updated.priority,
        weight: updated.weight,
        updatedAt: updated.updatedAt,
      },
    };
    markResponse();
    res.json(payload);
  } catch (error: any) {
    if (responseStarted) throw error;
    logger.error({ error }, 'Failed to update account');
    const payload = {
      error: {
        type: 'internal_error',
        message: error.message,
      },
    };
    markResponse();
    res.status(500).json(payload);
  }
}, 'account'));

/**
 * DELETE /admin/accounts/:id
 * 계정 삭제
 */
router.delete('/accounts/:id', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
  let responseStarted = false;
  const markResponse = () => { responseStarted = true; responding(); };
  try {
    const { id } = req.params;

    const account = accountRepo.findByIdAdmin(id);
    if (!account) {
      markResponse();
      res.status(404).json({
        error: {
          type: 'not_found',
          message: 'Account not found',
        },
      });
      return;
    }

    accountRepo.delete(id);
    logger.info({ accountId: id, name: account.name }, 'Account deleted');

    markResponse();
    res.status(204).end();
  } catch (error: any) {
    if (responseStarted) throw error;
    if (error?.message === 'account has usage history') {
      markResponse();
      res.status(409).json({ error: { type: 'conflict', message: 'Account has usage history; disable it instead' } });
      return;
    }
    logger.error({ error }, 'Failed to delete account');
    const payload = {
      error: {
        type: 'internal_error',
        message: error.message,
      },
    };
    markResponse();
    res.status(500).json(payload);
  }
}, 'account'));

/**
 * GET /admin/stats
 * 전체 통계
 */
router.get('/stats', authenticateAdmin, (_req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
    res.set('Cache-Control', 'no-store');
    const users = userRepo.findAll();
    const accounts = accountRepo.findAllAdmin();

    const stats = {
      todayUsage: usageRepo.getGlobalTodayCounts(),
      users: {
        total: users.length,
        enabled: users.filter(u => u.enabled).length,
        free: users.filter(u => u.tier === 'free').length,
        pro: users.filter(u => u.tier === 'pro').length,
      },
      accounts: {
        total: accounts.length,
        byProvider: {
          anthropic: accounts.filter(a => a.provider === 'anthropic').length,
          openai: accounts.filter(a => a.provider === 'openai').length,
          google: accounts.filter(a => a.provider === 'google').length,
        },
        byStatus: {
          active: accounts.filter(a => a.status === 'active').length,
          quota_exceeded: accounts.filter(a => a.status === 'quota_exceeded').length,
          error: accounts.filter(a => a.status === 'error').length,
          disabled: accounts.filter(a => a.status === 'disabled').length,
        },
      },
    };

    responding();
    res.json(stats);
}, 'stats'));

/**
 * GET /admin/settings/strategy/:provider
 * 라우팅 전략 조회
 */
router.get('/settings/strategy/:provider', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
  const { provider } = req.params;
  const strategy = settingsRepo.getStrategy(provider);
  const payload = { provider, strategy };
  responding();
  res.json(payload);
}, 'settings'));

/**
 * PUT /admin/settings/strategy/:provider
 * 라우팅 전략 설정
 */
router.put('/settings/strategy/:provider', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
  const { provider } = req.params;
  const { strategy } = req.body;
  if (!strategy || !STRATEGIES.includes(strategy)) {
    const payload = {
      error: {
        type: 'invalid_request',
        message: `Invalid strategy. Use one of: ${STRATEGIES.join(', ')}`,
      },
    };
    responding();
    res.status(400).json(payload);
    return;
  }
  settingsRepo.setStrategy(provider, strategy);
  const payload = { provider, strategy };
  responding();
  res.json(payload);
}, 'settings'));

/**
 * GET /admin/settings
 * 전체 설정 조회
 */
router.get('/settings', authenticateAdmin, (req: Request, res: Response) => ownedSyncUserRoute(res, (responding) => {
  const settings = settingsRepo.getAll();
  const payload = { settings };
  responding();
  res.json(payload);
}, 'settings'));

export default router;
