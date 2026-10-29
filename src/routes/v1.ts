/**
 * /v1 API 라우트 (OpenAI 호환)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateUser, authenticateUserWithoutQuota } from '../auth/user-auth.js';
import { forwardChat } from '../upstream/forward-chat.js';

const router = Router();


/**
 * POST /v1/chat/completions
 * OpenAI Chat Completions API 호환
 */
router.post('/chat/completions', authenticateUser, forwardChat);

/**
 * POST /v1/messages
 * Anthropic Messages API 호환
 */
router.post('/messages', authenticateUser, async (req: Request, res: Response) => {
  const user = req.user!;
  
  res.status(501).json({
    error: {
      type: 'not_implemented',
      message: 'Anthropic Messages API will be implemented soon.',
    },
  });
});

/**
 * GET /v1/models
 * 사용 가능한 모델 목록
 */
router.get('/models', authenticateUserWithoutQuota, (req: Request, res: Response) => {
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
});

export default router;
