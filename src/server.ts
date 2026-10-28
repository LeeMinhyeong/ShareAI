/**
 * 다계정 AI 라우터 서버
 */

import express from 'express';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { stopOAuth } from './upstream/oauth.js';
import { drainTokenRefreshes } from './upstream/tokens.js';

const app = express();

// CORS
if (env.CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', env.CORS_ORIGIN!);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });
}

app.use(express.json({ limit: '10mb' }));

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
  if (err instanceof SyntaxError && 'type' in err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { type: 'invalid_request', message: 'Invalid JSON' } });
  }
  if ('type' in err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { type: 'invalid_request', message: 'Request body too large' } });
  }
  if ('type' in err && (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
    return res.status(415).json({ error: { type: 'invalid_request', message: 'Unsupported request encoding' } });
  }
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  
  res.status(500).json({
    error: {
      type: 'internal_error',
      message: env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    },
  });
});

// 서버 시작
const server = app.listen(env.PORT, env.HOST, () => {
  try {
    initDatabase();
  } catch (err) {
    logger.error({ err }, 'Database initialization failed');
    closeDatabase();
    process.exitCode = 1;
    server.close();
    return;
  }
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

// Stop accepting requests, then close the database after active requests drain.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');
  const oauthDrained = stopOAuth();
  const refreshesDrained = drainTokenRefreshes();
  const deadline = setTimeout(() => {
    logger.error('Shutdown deadline exceeded; terminating remaining work');
    server.closeAllConnections();
    try { closeDatabase(); } catch (err) { logger.error({ err }, 'Failed to close database'); }
    process.exit(1);
  }, 5000);
  server.close(async (err) => {
    await Promise.all([refreshesDrained, oauthDrained]);
    clearTimeout(deadline);
    if (err) {
      logger.error({ err }, 'Failed to close HTTP server');
      process.exitCode = 1;
    }
    try {
      closeDatabase();
    } catch (error) {
      logger.error({ err: error }, 'Failed to close database');
      process.exitCode = 1;
    }
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
