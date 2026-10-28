/**
 * 사용자 인증 미들웨어
 */
import type { Request, Response, NextFunction } from 'express';
import { UserRepository } from '../db/repositories/users.js';
import { hashApiKey } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

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
export function authenticateUser(req: Request, res: Response, next: NextFunction): void {
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
  const user = userRepo.findByApiKeyHash(keyHash);

  if (!user) {
    logger.warn({ keyHash: keyHash.slice(0, 16) + '...' }, 'Invalid API key');
    res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Invalid API key.',
      },
    });
    return;
  }

  // 일일 제한 확인
  const todayUsage = userRepo.getTodayUsageCount(user.id);
  if (todayUsage >= user.dailyLimit) {
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
  next();
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
