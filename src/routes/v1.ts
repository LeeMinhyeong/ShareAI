/**
 * /v1 API 라우트 (OpenAI 호환)
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticateUser } from '../auth/user-auth.js';
import { AccountPoolManager } from '../account-pool/manager.js';
import { UsageLogRepository } from '../db/repositories/usage-logs.js';
import { logger } from '../utils/logger.js';

const router = Router();
const accountPool = new AccountPoolManager();
const usageRepo = new UsageLogRepository();

/**
 * POST /v1/chat/completions
 * OpenAI Chat Completions API 호환
 */
router.post('/chat/completions', authenticateUser, async (req: Request, res: Response) => {
  const user = req.user!;
  const startTime = Date.now();

  try {
    const { model, messages, stream = false, router_options } = req.body;

    if (!model || !messages) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Missing required fields: model, messages',
        },
      });
      return;
    }

    // 모델에서 제공자 추론
    const provider = inferProvider(model);
    
    // 계정 선택
    const strategy = router_options?.strategy || 'round_robin';
    const account = await accountPool.selectAccount(user.id, model, provider, strategy);

    if (!account) {
      res.status(503).json({
        error: {
          type: 'service_unavailable',
          message: `No available ${provider} accounts. All accounts are either quota-exceeded or in cooldown.`,
        },
      });
      return;
    }

    logger.info(
      { userId: user.id, model, provider, accountId: account.id, accountName: account.name },
      'Routing request'
    );

    // TODO: 실제 업스트림 요청 처리
    // 지금은 Mock 응답
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      res.write('data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1234567890,"model":"' + model + '","choices":[{"index":0,"delta":{"role":"assistant","content":"안녕하세요! "},"finish_reason":null}]}\n\n');
      
      setTimeout(() => {
        res.write('data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1234567890,"model":"' + model + '","choices":[{"index":0,"delta":{"content":"다계정 라우터가 정상 작동 중입니다."},"finish_reason":null}]}\n\n');
        
        setTimeout(() => {
          res.write('data: {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":1234567890,"model":"' + model + '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();

          // 사용량 기록
          logUsage(user.id, account.id, model, provider, 10, 50, true, Date.now() - startTime);
          accountPool.updateAccountStatus(account.id, { success: true, tokensUsed: 60 });
        }, 500);
      }, 500);
    } else {
      // Non-streaming 응답
      res.json({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '안녕하세요! 다계정 라우터가 정상 작동 중입니다. 실제 업스트림 연동은 구현 중입니다.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 30,
          total_tokens: 40,
        },
      });

      // 사용량 기록
      logUsage(user.id, account.id, model, provider, 10, 30, true, Date.now() - startTime);
      accountPool.updateAccountStatus(account.id, { success: true, tokensUsed: 40 });
    }
  } catch (error: any) {
    logger.error({ error, userId: user.id }, 'Request failed');
    
    res.status(500).json({
      error: {
        type: 'internal_error',
        message: error.message,
      },
    });
  }
});

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
router.get('/models', authenticateUser, (req: Request, res: Response) => {
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

/**
 * 모델명에서 제공자 추론
 */
function inferProvider(model: string): string {
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('gpt')) return 'openai';
  if (model.includes('gemini')) return 'google';
  return 'openai'; // 기본값
}

/**
 * 사용량 로그 기록
 */
function logUsage(
  userId: string,
  accountId: string,
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  success: boolean,
  latencyMs: number
) {
  try {
    usageRepo.create({
      userId,
      upstreamAccountId: accountId,
      model,
      provider,
      inputTokens,
      outputTokens,
      success,
      latencyMs,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to log usage');
  }
}

export default router;
