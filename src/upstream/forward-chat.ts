import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { accountPool } from '../account-pool/manager.js';
import { UsageLogRepository } from '../db/repositories/usage-logs.js';
import { RefreshIntentError } from '../db/repositories/accounts.js';
import { logger } from '../utils/logger.js';
import { resolveAuth } from './tokens.js';
import { infer, UpstreamError } from './inference.js';

const usageRepo = new UsageLogRepository();
export async function forwardChat(req: Request, res: Response) {
  const user = req.user!; const started = Date.now(); const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  let account: Awaited<ReturnType<typeof accountPool.selectAccount>> = null;
  let usedToken: string | undefined;
  let observedAccount: Awaited<ReturnType<typeof accountPool.selectAccount>> = null;
  try {
    const {model, messages, stream = false, router_options, temperature, max_tokens} = req.body ?? {};
    const allowed = new Set(['model','messages','stream','router_options','temperature','max_tokens']);
    if (typeof model !== 'string' || !model || !Array.isArray(messages) || typeof stream !== 'boolean' || Object.keys(req.body ?? {}).some(k => !allowed.has(k))) throw new UpstreamError(400, 'Invalid or unsupported chat request fields');
    if ((temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature))) || (max_tokens !== undefined && (!Number.isInteger(max_tokens) || max_tokens <= 0))) throw new UpstreamError(400, 'Invalid generation options');
    const provider = model.includes('claude') ? 'anthropic' : /^(gpt|o1|o3|o4|codex)/.test(model) ? 'openai' : null;
    if (!provider) throw new UpstreamError(400, 'Unsupported provider');
    account = await accountPool.selectAccount(user.id, model, provider, router_options?.strategy || 'round_robin', {credentialTypes:['oauth','api_key']});
    if (!account) throw new UpstreamError(503, 'No supported upstream account available');
    const auth = await resolveAuth(account);
    observedAccount = auth.observedAccount;
    if (observedAccount.credentialType !== auth.kind) throw new UpstreamError(400, 'Invalid stored credentials');
    const request = {model, messages, temperature, max_tokens};
    usedToken = auth.token;
    let events;
    try { events = await infer(provider, auth, request, undefined, controller.signal); }
    catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 401 || !auth.canRefresh) throw error;
      const refreshed = await resolveAuth(auth.observedAccount, {forceRefresh:true, rejectedToken:auth.token});
      observedAccount = refreshed.observedAccount;
      if (refreshed.kind !== 'oauth') throw new UpstreamError(400, 'Invalid refreshed credentials');
      usedToken = refreshed.token;
      events = await infer(provider, refreshed, request, undefined, controller.signal);
    }
    const id = 'chatcmpl-' + randomUUID(), created = Math.floor(Date.now()/1000);
    let content = '', finish = 'stop'; let usage: {input:number; output:number} | undefined;
    if (stream) {
      res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
      const write = async (delta: object, reason: string | null = null) => {
        const data = {id, object:'chat.completion.chunk', created, model, choices:[{index:0,delta,finish_reason:reason}]};
        if (!res.write(`data: ${JSON.stringify(data)}\n\n`)) await once(res,'drain', {signal:controller.signal});
      };
      await write({role:'assistant'});
      for await (const e of events) { if (e.text !== undefined) await write({content:e.text}); if (e.finish) finish = e.finish; if (e.usage) usage = e.usage; }
      await write({}, finish); res.end('data: [DONE]\n\n');
    } else {
      for await (const e of events) { if (e.text !== undefined) content += e.text; if (e.finish) finish = e.finish; if (e.usage) usage = e.usage; }
      res.json({id, object:'chat.completion', created, model, choices:[{index:0,message:{role:'assistant',content},finish_reason:finish}], ...(usage ? {usage:{prompt_tokens:usage.input, completion_tokens:usage.output,total_tokens:usage.input+usage.output}} : {})});
    }
    accountPool.recordSuccess(account.id, true, observedAccount ?? account, usedToken);
    if (usage) {
      try { usageRepo.create({userId:user.id, upstreamAccountId:account.id, model, provider, inputTokens:usage.input, outputTokens:usage.output, success:true, latencyMs:Date.now()-started}); }
      catch { logger.error('Failed to log usage'); }
    }
  } catch (error: any) {
    const status = error instanceof RefreshIntentError ? 503 : error instanceof UpstreamError ? error.status : 502;
    if (account && !controller.signal.aborted && status !== 400 && !(error instanceof RefreshIntentError)) accountPool.recordFailure(account.id, {status, message:`Upstream request failed (${status})`}, observedAccount ?? account, usedToken);
    logger.error({status, userId:user.id}, 'Inference request failed');
    if (res.headersSent) res.destroy();
    else res.status(status >= 400 && status <= 599 ? status : 502).json({error:{type:status === 400 ? 'invalid_request_error' : 'upstream_error',message:error instanceof RefreshIntentError ? 'Token refresh is in progress or its outcome is uncertain; retry later or reauthenticate' : error instanceof UpstreamError ? error.message : 'Upstream request failed'}});
  }
}
