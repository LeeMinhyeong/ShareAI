/**
 * /admin API 라우트 (관리자 전용)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateAdmin } from '../auth/user-auth.js';
import { UserRepository } from '../db/repositories/users.js';
import { AccountRepository } from '../db/repositories/accounts.js';
import { UsageLogRepository } from '../db/repositories/usage-logs.js';
import { generateApiKey, hashApiKey } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { startLogin, finishLogin, getFlow, setOnLoginComplete, parseImportedCredential, type OAuthProvider } from '../upstream/oauth.js';

import { SettingsRepository, STRATEGIES } from '../db/repositories/settings.js';

const router = Router();
const userRepo = new UserRepository();
const accountRepo = new AccountRepository();
const usageRepo = new UsageLogRepository();
const settingsRepo = new SettingsRepository();

setOnLoginComplete(async (flow, parsed) => accountRepo.create({
  ...flow.params, provider: flow.provider, credentialType: parsed.credentialType,
  credentials: parsed.credentials, meta: parsed.meta,
}).id);

function onboardingParams(body: any) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 ||
      !['anthropic', 'openai'].includes(body.provider) ||
      (body.dailyQuota !== undefined && (!Number.isSafeInteger(body.dailyQuota) || body.dailyQuota < 0)) ||
      (body.priority !== undefined && (!Number.isSafeInteger(body.priority) || body.priority < 0)) ||
      (body.weight !== undefined && (!Number.isSafeInteger(body.weight) || body.weight < 1))) return null;
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

router.post('/accounts/import', authenticateAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const params = onboardingParams(req.body);
  if (!params || typeof req.body?.credentials !== 'string' || !req.body.credentials || req.body.credentials.length > 65536)
    return res.status(400).json({ error: { message: 'Invalid account parameters or credentials' } });
  try {
    const parsed = parseImportedCredential(params.provider, req.body.credentials);
    const account = accountRepo.create({ ...params, ...parsed });
    return res.status(201).json({ account: { id: account.id, name: account.name, provider: account.provider, credentialType: account.credentialType, status: account.status } });
  } catch { return res.status(400).json({ error: { message: 'Could not import credentials' } }); }
});

/**
 * POST /admin/users
 * 사용자 생성
 */
router.post('/users', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { name, email, tier = 'free', dailyLimit = 100 } = req.body;

    if (!name || !email) {
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
  } catch (error: any) {
    logger.error({ error }, 'Failed to create user');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/users
 * 사용자 목록
 */
router.get('/users', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const users = userRepo.findAll();

    res.json({
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
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to list users');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/users/:id
 * 사용자 상세 (사용량 포함)
 */
router.get('/users/:id', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = userRepo.findById(id);

    if (!user) {
      res.status(404).json({
        error: {
          type: 'not_found',
          message: 'User not found',
        },
      });
      return;
    }

    const todayStats = usageRepo.getTodayStats(id);
    const recentLogs = usageRepo.findByUser(id, 20);

    res.json({
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
        success: log.success,
        error: log.error,
        latencyMs: log.latencyMs,
      })),
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get user details');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * PATCH /admin/users/:id
 * 사용자 수정
 */
router.patch('/users/:id', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, email, tier, dailyLimit, enabled } = req.body;

    const user = userRepo.findById(id);
    if (!user) {
      res.status(404).json({
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
    res.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        tier: updated.tier,
        dailyLimit: updated.dailyLimit,
        enabled: updated.enabled,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to update user');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * POST /admin/accounts
 * 계정 생성
 */
router.post('/accounts', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { name, provider, credentialType, credentials, dailyQuota = 0, priority = 0, weight = 1 } = req.body;

    if (!name || !provider || !credentialType || !credentials) {
      res.status(400).json({
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

    res.status(201).json({
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
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to create account');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/accounts
 * 계정 목록
 */
router.get('/accounts', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const accounts = accountRepo.findAll();

    res.json({
      accounts: accounts.map(acc => ({
        id: acc.id,
        name: acc.name,
        provider: acc.provider,
        credentialType: acc.credentialType,
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
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to list accounts');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/accounts/:id
 * 계정 상세 (사용량 포함)
 */
router.get('/accounts/:id', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const account = accountRepo.findById(id);

    if (!account) {
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

    res.json({
      account: {
        id: account.id,
        name: account.name,
        provider: account.provider,
        credentialType: account.credentialType,
        // credentials는 보안상 노출하지 않음
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
        success: log.success,
        latencyMs: log.latencyMs,
      })),
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get account details');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * PATCH /admin/accounts/:id
 * 계정 수정
 */
router.patch('/accounts/:id', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, status, dailyQuota, priority, weight, credentials } = req.body;

    const account = accountRepo.findById(id);
    if (!account) {
      res.status(404).json({
        error: {
          type: 'not_found',
          message: 'Account not found',
        },
      });
      return;
    }

    accountRepo.update(id, { name, status, dailyQuota, priority, weight, credentials });

    logger.info({ accountId: id }, 'Account updated');

    const updated = accountRepo.findById(id)!;
    res.json({
      account: {
        id: updated.id,
        name: updated.name,
        provider: updated.provider,
        status: updated.status,
        dailyQuota: updated.dailyQuota,
        priority: updated.priority,
        weight: updated.weight,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (error: any) {
    logger.error({ error }, 'Failed to update account');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * DELETE /admin/accounts/:id
 * 계정 삭제
 */
router.delete('/accounts/:id', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const account = accountRepo.findById(id);
    if (!account) {
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

    res.status(204).end();
  } catch (error: any) {
    logger.error({ error }, 'Failed to delete account');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/stats
 * 전체 통계
 */
router.get('/stats', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const users = userRepo.findAll();
    const accounts = accountRepo.findAll();

    const stats = {
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

    res.json(stats);
  } catch (error: any) {
    logger.error({ error }, 'Failed to get stats');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/settings/strategy/:provider
 * 라우팅 전략 조회
 */
router.get('/settings/strategy/:provider', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const strategy = settingsRepo.getStrategy(provider);
    res.json({ provider, strategy });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get strategy');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * PUT /admin/settings/strategy/:provider
 * 라우팅 전략 설정
 */
router.put('/settings/strategy/:provider', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const { strategy } = req.body;
    if (!strategy || !STRATEGIES.includes(strategy)) {
      res.status(400).json({
        error: {
          type: 'invalid_request',
          message: `Invalid strategy. Use one of: ${STRATEGIES.join(', ')}`,
        },
      });
      return;
    }
    settingsRepo.setStrategy(provider, strategy);
    res.json({ provider, strategy });
  } catch (error: any) {
    logger.error({ error }, 'Failed to set strategy');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

/**
 * GET /admin/settings
 * 전체 설정 조회
 */
router.get('/settings', authenticateAdmin, (req: Request, res: Response) => {
  try {
    const settings = settingsRepo.getAll();
    res.json({ settings });
  } catch (error: any) {
    logger.error({ error }, 'Failed to get settings');
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

export default router;
