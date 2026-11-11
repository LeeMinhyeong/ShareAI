/**
 * /v1 API 라우트 (OpenAI 호환)
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authenticateUserInDispatch } from '../auth/user-auth.js';
import { forwardChat, forwardMessages, forwardResponses, anthropicErrorEnvelope, anthropicErrorBody } from '../upstream/forward-chat.js';
import { requestWork } from '../request-work.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

const router = Router();

const isMessagesPath = (url: string) => /^\/messages\/?(?:\?|$)/i.test(url);

// Deny even unmatched v1 paths after stop. Each known endpoint acquires its
// own private lease before it starts; request identity is not a capability.
const dispatchRouter = router as typeof router & { handle(req: Request, res: Response, out: NextFunction): void };
const handle = dispatchRouter.handle;
dispatchRouter.handle = function (req: Request, res: Response, out: NextFunction) {
  if (requestWork.isAccepting()) return handle.call(router, req, res, out);
  try {
    if (isMessagesPath(req.url)) res.status(503).json(anthropicErrorBody(503, 'Server is shutting down.'));
    else res.status(503).json({ error: { type: 'service_unavailable', message: 'Server is shutting down.' } });
  }
  catch { try { res.destroy(); } catch { /* best effort */ } }
};

// Covers the whole route promise, not the socket lifetime.
// Other server producers are not covered by this manager.
function trackedRoute(handler: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, _next: NextFunction): void => {
    const admitted = requestWork.ownedDispatch(scope => {
      const work = scope.run(async () => {
        try {
          if (!res.destroyed) await handler(req, res);
          scope.terminal();
        } catch {
          // Never hand an owned failure to Express: next() can schedule work
          // without returning its promise. Log only a freshly normalized error.
          try { logger.error({ err: new Error('Internal server error.'), path: req.path, method: req.method }, 'Unhandled error'); } catch { /* best effort */ }
          try {
            if (res.destroyed || res.writableEnded) return;
            if (res.headersSent) res.destroy();
            else res.status(500).json({ error: {
              type: 'internal_error',
              message: env.NODE_ENV === 'production' ? 'Internal server error' : 'Internal server error.',
            } });
          } catch { try { res.destroy(); } catch { /* best effort */ } }
          finally { scope.terminal(); }
        }
      });
      if (work) void work;
    });
    if (!admitted) {
      try { res.status(503).json({ error: { type: 'service_unavailable', message: 'Server is shutting down.' } }); }
      catch { try { res.destroy(); } catch { /* best effort */ } }
    }
  };
}


// Express's automatic OPTIONS responder does not invoke the router callback.
if (typeof router.use === 'function') {
  const options = trackedRoute((req, res) => {
    const allow = /^\/models\/?(?:\?|$)/i.test(req.url) ? 'GET,HEAD' : 'POST';
    return res.set('Allow', allow).send(allow);
  });
  router.use((req, res, next) => {
    if (req.method === 'OPTIONS' && /^\/(?:models|messages|responses|chat\/completions)\/?(?:\?|$)/i.test(req.url)) options(req, res, next);
    else next();
  });
}

function ownedEndpoint(reserveQuota: boolean, handler: (req: Request, res: Response) => unknown) {
  return trackedRoute((req, res) =>
    authenticateUserInDispatch(req, res, () => {
      if (!res.destroyed) return handler(req, res);
    }, reserveQuota));
}

/**
 * POST /v1/chat/completions
 * OpenAI Chat Completions API 호환
 */
router.post('/chat/completions', ownedEndpoint(true, forwardChat));

/**
 * POST /v1/messages
 * Anthropic Messages passthrough for Claude Code (ADR 0019)
 */
// One layer only: the envelope is installed inside the route handler, never via Express next().
const ownedMessages = ownedEndpoint(true, forwardMessages);
router.post('/messages', (req: Request, res: Response, next: NextFunction) => {
  anthropicErrorEnvelope(res);
  return ownedMessages(req, res, next);
});

/**
 * POST /v1/responses
 * OpenAI Responses passthrough for Codex (ADR 0019)
 */
router.post('/responses', ownedEndpoint(true, forwardResponses));

/**
 * GET /v1/models
 * 사용 가능한 모델 목록
 */
router.get('/models', ownedEndpoint(false, (req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-3-5-sonnet-20241022', object: 'model', owned_by: 'anthropic' },
      { id: 'claude-3-5-haiku-20241022', object: 'model', owned_by: 'anthropic' },
      { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
      { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
      { id: 'gemini-2.0-flash-exp', object: 'model', owned_by: 'google' },
    ],
  });
}));

export default router;
