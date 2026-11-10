/**
 * 다계정 AI 라우터 서버
 */

import express from 'express';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { stopOAuth } from './upstream/oauth.js';
import { stopSiwc, noStoreSiwc } from './upstream/siwc-login.js';
import { drainTokenRefreshes } from './upstream/tokens.js';
import { requestWork, trackedErrorHandler } from './request-work.js';

const app = express();
let ready = false;
// Set before the JSON parser so even malformed or oversized requests are private.
app.all(['/admin/routing-snapshot', '/api/admin/routing-snapshot'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/admin/accounts/siwc', noStoreSiwc);
app.use('/admin/siwc', noStoreSiwc);
// A bound socket is not ready to serve until DB initialization and scheduler
// startup have completed. Keep this ahead of parsers and application routes.
app.use((_req, res, next) => {
  if (!ready) return res.status(503).end();
  next();
});

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
import { initDatabase, requireInitializedDatabase } from './db/client.js';
import { assert429V2Schema } from './db/account-429-v2-store.js';
import { Account429V2Expiry } from './db/account-429-v2-expiry.js';

// API 라우트
import v1Router from './routes/v1.js';
import adminRouter from './routes/admin.js';

app.use('/v1', v1Router);
// Only this dashboard endpoint has a same-origin /api alias. Route it through
// the existing admin router so its authentication remains authoritative.
app.get('/api/admin/routing-snapshot', (req, _res, next) => {
  const queryIndex = req.url.indexOf('?');
  req.url = '/admin/routing-snapshot' + (queryIndex < 0 ? '' : req.url.slice(queryIndex));
  next();
});
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
app.use(trackedErrorHandler((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
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
}));

// 서버 시작
let deadlineFired = false;
let expiry: Account429V2Expiry | undefined;
let server: ReturnType<typeof app.listen> | undefined;
let startupFailed = false;
let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let deadlineExited = false;
let startupStarted = false;
function armShutdownDeadline(): void {
  if (shutdownDeadline) return;
  shutdownDeadline = setTimeout(() => {
    if (deadlineExited) return;
    deadlineExited = true;
    deadlineFired = true;
    process.exitCode = 1;
    try {
      try { logger.error('Shutdown deadline exceeded; terminating remaining work'); } catch { /* best effort */ }
      try { server?.closeAllConnections(); } catch { /* best effort */ }
    } finally {
      // Pending work may still use the database; process termination releases it.
      process.exit(1);
    }
  }, 5000);
}
function failStartup(message: string): void {
  ready = false;
  if (startupFailed) return;
  startupFailed = true;
  deadlineFired = true;
  // A fatal error cannot prove all database producers drained, even before
  // listening. Retain the database until bounded process termination.
  armShutdownDeadline();
  process.exitCode = 1;
  // Normal shutdown has already started the same admission barriers.
  if (!shuttingDown) {
    // Handle throws and rejections without logging until both admissions are shut.
    const stop = (fn: () => unknown): void => {
      try { void Promise.resolve(fn()).catch(() => {}); } catch { /* best effort */ }
    };
    stop(() => requestWork.stopAndDrain());
    stop(() => drainTokenRefreshes());
    stop(() => expiry?.stopAndDrain());
    // A listener error can arrive after startup while separate OAuth/SIWC
    // callback servers or admitted operations are still active. Start their
    // own stop paths as well; the referenced hard deadline remains decisive.
    stop(() => stopOAuth());
    stop(() => stopSiwc());
    stop(() => server?.close());
  }
  try { logger.error(message); } catch { /* best effort */ }
}
try {
  server = app.listen(env.PORT, env.HOST, () => {
    if (startupStarted || deadlineFired || startupFailed || shuttingDown) return;
    startupStarted = true;
    try {
      initDatabase();
      if (deadlineFired || startupFailed || shuttingDown) return;
      assert429V2Schema(requireInitializedDatabase());
      if (deadlineFired || startupFailed || shuttingDown) return;
      expiry = new Account429V2Expiry({
        onFailure: () => { try { logger.error('429 expiry scheduler failed'); } catch { /* best effort */ } },
        monotonic: () => process.hrtime.bigint(),
        setTimer: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
        clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
        intervalMs: 1000,
        maxObservations: 1024,
        scanBatch: 256,
      });
      if (deadlineFired || startupFailed || shuttingDown) return;
      expiry.start();
      if (deadlineFired || startupFailed || shuttingDown) return;
      ready = true;
      logger.info({port: env.PORT, host: env.HOST, env: env.NODE_ENV}, '🚀 Multi-Account Router started');
      logger.info('📖 See 다계정-라우터-설계.md for architecture and implementation guide');
    } catch {
      failStartup('Server startup failed');
    }
  });
  server.on('error', () => failStartup('HTTP listener failed'));
  // After shutdown starts, a keep-alive connection that becomes idle must not hold the process (and
  // server.close) open until the deadline: close it as soon as its in-flight response finishes.
  // Only this response's own socket is ended, and gracefully (end flushes buffered output before
  // FIN), so another connection's unflushed response tail is never cut.
  server.on('request', (req, res) => {
    const socket = req.socket;
    res.once('finish', () => {
      if (!shuttingDown) return;
      setImmediate(() => { try { if (!socket.destroyed) socket.end(); } catch { /* best effort */ } });
    });
  });
} catch {
  failStartup('Server startup failed');
}

// The request-work barrier is additive: parser/admin callbacks and forwarding
// internals are not all owned by it, so this is not a complete producer drain.
function shutdown(signal: string): void {
  ready = false;
  if (startupFailed) return;
  if (shuttingDown) return;
  shuttingDown = true;
  // Process shutdown is capped at 5s while the event loop runs. SIWC's own
  // independent 15s guard is for other callers; this server does not retry it.
  // On timeout, terminate without closing a database pending work might use.
  armShutdownDeadline();
  const failure = (message: string): void => {
    process.exitCode = 1;
    try { logger.error(message); } catch { /* best effort */ }
  };
  // Attach rejection handlers immediately, including if a later stop throws.
  const startDrain = (stop: () => Promise<unknown>, message: string): Promise<boolean> => {
    try {
      return Promise.resolve(stop()).then(() => true, () => { failure(message); return false; });
    } catch {
      // Defer failure logging until both admission barriers have been started.
      return Promise.resolve().then(() => { failure(message); return false; });
    }
  };
  // Close both admissions before any external logger or stop hook can reenter.
  // Already-owned work and token flights may still finish.
  const requestDrain = startDrain(() => requestWork.stopAndDrain(), 'Failed to drain request work');
  const tokenDrain = startDrain(drainTokenRefreshes, 'Failed to drain token refreshes');
  const expiryDrain = startDrain(() => expiry ? expiry.stopAndDrain() : Promise.resolve(), 'Failed to drain 429 expiry scheduler');
  try { logger.info({ signal }, 'Shutting down gracefully'); }
  catch { failure('Failed to log shutdown'); }

  // One explicit retry can close a listener retained after a failed close.
  // Keep the original failure status even if the second attempt succeeds.
  // The deadline remains armed throughout, and no retry starts after it fires.
  const oauthDrain = startDrain(stopOAuth, 'Failed to stop OAuth').then(ok => {
    if (ok || deadlineFired) return ok;
    return startDrain(stopOAuth, 'Failed to retry stopping OAuth').then(() => false);
  });
  const drains = [
    requestDrain,
    oauthDrain,
    startDrain(stopSiwc, 'Failed to stop SIWC'),
    tokenDrain,
    expiryDrain,
  ];
  try {
    if (!server) return;
    server.close((err) => {
      if (deadlineFired) return;
      if (err) failure('Failed to close HTTP server');
      void Promise.all(drains).then((results) => {
        // A failed drain or HTTP close does not establish that work is finished.
        if (deadlineFired || err || results.some(result => !result)) return;
        // The registered drains do not cover every possible DB producer yet.
        // Retain both the singleton and quarantined connections until process
        // exit rather than closing them underneath an untracked continuation.
        // The deadline still fires if other work keeps the process alive, but
        // does not itself prevent an otherwise idle process from exiting.
        try { shutdownDeadline?.unref(); }
        catch { failure('Failed to unref shutdown deadline'); }
      }).catch(() => { if (!deadlineFired) failure('Failed to complete shutdown'); });
    });
    // Connections already idle when shutdown starts close now (Node >= 19 close() also does this; kept
    // explicit). Busy ones are ended when their response finishes (request listener above).
    try { server.closeIdleConnections(); } catch { /* best effort */ }
  } catch {
    failure('Failed to close HTTP server');
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
