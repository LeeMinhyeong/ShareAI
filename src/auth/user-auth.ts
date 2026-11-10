/**
 * 사용자 인증 미들웨어
 */
import type { Request, Response, NextFunction } from 'express';
import { UserRepository } from '../db/repositories/users.js';
import { hashApiKey } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { withAsyncWriter } from '../db/async-writer.js';
import { requestWork } from '../request-work.js';
import type { OwnedDispatch } from '../request-work.js';

const userRepo = new UserRepository();

/**
 * 요청에 사용자 정보 추가
 */
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name: string;
        email: string;
        tier: 'free' | 'pro';
        dailyLimit: number;
      };
    }
  }
}

/**
 * API 키 기반 사용자 인증
 */
export function authenticateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  return trackedAuthenticate(req, res, next, true);
}

/** Authenticate read-only routes without reserving an inference request. */
export function authenticateUserWithoutQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
  return trackedAuthenticate(req, res, next, false);
}

/** The caller owns this entire promise, including the authenticated handler. */
export function authenticateUserInDispatch(req: Request, res: Response, handler: () => unknown, reserveQuota: boolean): Promise<void> {
  return authenticate(req, res, handler, reserveQuota);
}

function trackedAuthenticate(req: Request, res: Response, next: NextFunction, reserveQuota: boolean, scope?: OwnedDispatch): Promise<void> {
  let forwarded = false;
  const fallback = () => {
    try { logger.error('Authentication continuation failed'); } catch { /* best effort */ }
    try {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else res.status(500).json({ error: { type: 'internal_error', message: 'Internal server error.' } });
    } catch { try { res.destroy(); } catch { /* best effort */ } }
  };
  const report = async (error: unknown) => {
    if (!forwarded) {
      forwarded = true;
      try { if (scope) next(new Error('Internal server error.')); else requestWork.handoff(req, () => next(new Error('Internal server error.'))); return; } catch { /* do not invoke next twice */ }
    }
    fallback();
  };
  const run = scope ? scope.run : requestWork.run.bind(requestWork);
  const work = run(async () => {
    try {
      await authenticate(req, res, () => {
        forwarded = true;
        return scope ? next() : requestWork.handoff(req, () => next());
      }, reserveQuota);
    } catch (error) { await report(error); }
    finally { if (scope && !forwarded) scope.terminal(); }
  });
  if (!work) {
    return (async () => {
      try { res.status(503).json({ error: { type: 'service_unavailable', message: 'Server is shutting down.' } }); }
      catch (error) { await report(error); }
    })();
  }
  return work;
}

async function authenticate(req: Request, res: Response, next: () => unknown, reserveQuota: boolean): Promise<void> {
  // Authorization 헤더 또는 x-api-key 헤더에서 키 추출
  let apiKey: string | undefined;
  
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.slice(7);
  } else if (req.headers['x-api-key']) {
    apiKey = req.headers['x-api-key'] as string;
  }

  if (!apiKey) {
    res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Missing API key. Provide Authorization: Bearer <key> or x-api-key header.',
      },
    });
    return;
  }

  // API 키 해시 후 DB 조회
  const keyHash = hashApiKey(apiKey);
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on?.('close', onClose);
  if (res.destroyed && !res.writableEnded) controller.abort();
  const cleanup = () => res.off?.('close', onClose);
  const fail = (error: unknown) => {
    cleanup();
    if (controller.signal.aborted) return;
    logger.error(reserveQuota ? 'User quota reservation failed' : 'User authentication lookup failed');
    res.status(503).json({ error: { type: 'service_unavailable', message: reserveQuota ? 'Unable to reserve daily quota.' : 'Unable to authenticate user.' } });
  };
  const finish = (reservation: ReturnType<UserRepository['reserveDailyQuota']> | undefined, user: ReturnType<UserRepository['findByApiKeyHash']>) => {
  cleanup();
  if (controller.signal.aborted) return;

  if (!user) {
    logger.warn('Invalid API key');
    res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Invalid API key.',
      },
    });
    return;
  }

  // 일일 제한 확인
  if (reservation && !reservation.allowed) {
    const todayUsage = reservation.used;
    logger.warn({ userId: user.id, todayUsage, limit: user.dailyLimit }, 'User daily limit exceeded');
    res.status(429).json({
      error: {
        type: 'rate_limit_exceeded',
        message: `Daily limit of ${user.dailyLimit} requests exceeded. Current usage: ${todayUsage}.`,
      },
    });
    return;
  }

  // 요청에 사용자 정보 추가
  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    tier: user.tier,
    dailyLimit: user.dailyLimit,
  };

  logger.debug({ userId: user.id, email: user.email }, 'User authenticated');
  return next();
  };
  let reservation: ReturnType<UserRepository['reserveDailyQuota']> | undefined;
  let user: ReturnType<UserRepository['findByApiKeyHash']>;
  try {
    if (!reserveQuota) user = userRepo.findByApiKeyHash(keyHash);
    else {
      const result = withAsyncWriter(db => userRepo.reserveDailyQuota(keyHash, undefined, db), {signal: controller.signal});
      reservation = result instanceof Promise ? await result : result;
      user = reservation.user;
    }
  } catch (error) { fail(error); return; }
  await finish(reservation, user);
}

/**
 * 관리자 인증 (env.ADMIN_API_KEY 확인)
 */
export function authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Missing admin API key.',
      },
    });
    return;
  }

  const providedKey = authHeader.slice(7);

  if (providedKey !== env.ADMIN_API_KEY) {
    logger.warn('Invalid admin API key attempt');
    res.status(403).json({
      error: {
        type: 'permission_denied',
        message: 'Invalid admin API key.',
      },
    });
    return;
  }

  logger.debug('Admin authenticated');
  next();
}
