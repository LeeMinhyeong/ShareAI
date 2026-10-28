/**
 * 다계정 AI 라우터 서버
 */

import express from 'express';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const app = express();

// 미들웨어
app.use(express.json({ limit: '10mb' }));

// CORS
if (env.CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', env.CORS_ORIGIN!);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });
}

// 헬스체크
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// 메트릭 (Prometheus)
app.get('/metrics', (req, res) => {
  // TODO: prom-client 메트릭 반환
  res.type('text/plain');
  res.send('# TODO: Prometheus metrics\n');
});

// 데이터베이스 초기화
import { initDatabase, closeDatabase } from './db/client.js';
initDatabase();

// API 라우트
import v1Router from './routes/v1.js';
import adminRouter from './routes/admin.js';

app.use('/v1', v1Router);
app.use('/admin', adminRouter);

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({
    error: {
      type: 'not_found',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// 에러 핸들러
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  
  res.status(500).json({
    error: {
      type: 'internal_error',
      message: env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    },
  });
});

// 서버 시작
app.listen(env.PORT, env.HOST, () => {
  logger.info(
    {
      port: env.PORT,
      host: env.HOST,
      env: env.NODE_ENV,
    },
    '🚀 Multi-Account Router started'
  );
  
  logger.info('📖 See 다계정-라우터-설계.md for architecture and implementation guide');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
