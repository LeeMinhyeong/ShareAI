import type { ResolvedAuth } from './tokens.js';

export type ChatRequest = { model: string; messages: {role:string; content:string}[]; temperature?: number; max_tokens?: number };
export type InferenceEvent = { text?: string; id?: string; finish?: string; usage?: {input:number; output:number} };
export class UpstreamError extends Error {
  headers?: Record<string, string>;
  constructor(public status: number, message: string, headers?: Record<string, string>) { super(message); this.headers = headers; }
}

export async function infer(provider: string, auth: Omit<ResolvedAuth, 'observedAccount'>, request: ChatRequest, endpoint?: string, signal?: AbortSignal): Promise<AsyncGenerator<InferenceEvent>> {
  if (!['openai','anthropic'].includes(provider) || !['oauth','api_key'].includes(auth.kind) || !auth.token || /[\r\n]/.test(auth.token)) throw new UpstreamError(400, 'Unsupported or invalid credentials');
  if (auth.kind === 'api_key' && !(provider === 'anthropic' ? auth.token.startsWith('sk-ant-api') : auth.token.startsWith('sk-'))) throw new UpstreamError(400, 'Unsupported or invalid API key');
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.some(m => !m || !['system','developer','user','assistant'].includes(m.role) || typeof m.content !== 'string' || Object.keys(m).some(k => k !== 'role' && k !== 'content'))) throw new UpstreamError(400, 'Only text system, developer, user and assistant messages are supported');
  const system = request.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n\n');
  const messages = request.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (!messages.length) throw new UpstreamError(400, 'At least one user or assistant message is required');
  let url: string, headers: Record<string,string>, body: any, protocol: string;
  if (provider === 'anthropic') {
    url = endpoint || 'https://api.anthropic.com/v1/messages?beta=true';
    headers = {'content-type':'application/json','anthropic-version':'2023-06-01', ...(auth.kind === 'oauth' ? {'authorization':`Bearer ${auth.token}`, 'anthropic-beta':'claude-code-20250219,oauth-2025-04-20', 'user-agent':'claude-cli/2.1.0'} : {'x-api-key':auth.token})};
    const systemValue = auth.kind === 'oauth' ? [{type:'text', text:"You are Claude Code, Anthropic's official CLI for Claude."}, ...(system ? [{type:'text',text:system}] : [])] : system;
    body = {model:request.model, messages, max_tokens:request.max_tokens ?? 1024, stream:true, ...(systemValue ? {system:systemValue} : {}), ...(request.temperature !== undefined ? {temperature:request.temperature} : {})};
    protocol = 'anthropic';
  } else if (auth.kind === 'oauth') {
    if (!auth.accountId || /[\r\n]/.test(auth.accountId)) throw new UpstreamError(400, 'Codex OAuth requires a ChatGPT account ID');
    if (request.temperature !== undefined || request.max_tokens !== undefined) throw new UpstreamError(400, 'Codex OAuth does not support temperature or max_tokens');
    url = endpoint || 'https://chatgpt.com/backend-api/codex/responses';
    headers = {'content-type':'application/json', 'authorization':`Bearer ${auth.token}`, 'chatgpt-account-id':auth.accountId, 'originator':'codex_cli_rs', 'accept':'text/event-stream'};
    body = {model:request.model, instructions:system || 'You are a helpful assistant.', input:messages.map(m => ({role:m.role, content:[{type:m.role === 'assistant' ? 'output_text':'input_text', text:m.content}]})), stream:true, store:false};
    protocol = 'codex';
  } else {
    url = endpoint || 'https://api.openai.com/v1/chat/completions';
    headers = {'content-type':'application/json', 'authorization':`Bearer ${auth.token}`};
    body = {...request, stream:true, stream_options:{include_usage:true}};
    protocol = 'openai';
  }
  const response = await fetch(url, {method:'POST', headers, body:JSON.stringify(body), signal});
  if (!response.ok) { const respHeaders = Object.fromEntries(response.headers.entries()); await response.body?.cancel(); throw new UpstreamError(response.status, `Upstream returned HTTP ${response.status}`, respHeaders); }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) { await response.body?.cancel(); throw new UpstreamError(502, 'Upstream did not return an event stream'); }
  return parseEvents(response.body, protocol);
}

async function* parseEvents(body: ReadableStream<Uint8Array>, protocol: string): AsyncGenerator<InferenceEvent> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let complete = false; let input = 0, output = 0, hasUsage = false;
  try {
    while (true) {
      const {value, done} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { if (protocol === 'openai') complete = true; continue; }
        let e: any; try { e = JSON.parse(data); } catch { throw new UpstreamError(502, 'Malformed upstream event'); }
        if (e.type === 'error' || e.type === 'response.failed' || e.error) throw new UpstreamError(502, 'Upstream stream failed');
        if (protocol === 'codex') {
          if (e.type === 'response.output_item.added' && e.item?.type !== 'message' && e.item?.type !== 'reasoning') throw new UpstreamError(502, 'Unsupported upstream output item');
          if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') yield {text:e.delta};
          if (e.type === 'response.completed') { complete = true; const u = e.response?.usage; yield {id:e.response?.id, finish:'stop', ...(u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens) ? {usage:{input:u.input_tokens,output:u.output_tokens}} : {})}; }
          if (e.type === 'response.incomplete') throw new UpstreamError(502, 'Upstream response incomplete');
        } else if (protocol === 'anthropic') {
          if (e.type === 'message_start') { input = e.message?.usage?.input_tokens ?? 0; hasUsage = Number.isFinite(e.message?.usage?.input_tokens); yield {id:e.message?.id}; }
          if (e.type === 'content_block_start' && e.content_block?.type !== 'text') throw new UpstreamError(502, 'Unsupported upstream content block');
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') yield {text:e.delta.text};
          if (e.type === 'message_delta') { output = e.usage?.output_tokens ?? 0; hasUsage = hasUsage && Number.isFinite(e.usage?.output_tokens); yield {finish:e.delta?.stop_reason === 'max_tokens' ? 'length' : 'stop'}; }
          if (e.type === 'message_stop') { complete = true; if (hasUsage) yield {usage:{input,output}}; }
        } else {
          const c = e.choices?.[0]; if (c?.delta?.content) yield {text:c.delta.content};
          if (c?.delta?.tool_calls || c?.delta?.function_call) throw new UpstreamError(502, 'Unsupported upstream tool call');
          if (c?.finish_reason) yield {finish:c.finish_reason};
          if (e.id) yield {id:e.id};
          if (e.usage && Number.isFinite(e.usage.prompt_tokens) && Number.isFinite(e.usage.completion_tokens)) yield {usage:{input:e.usage.prompt_tokens,output:e.usage.completion_tokens}};
        }
      }
      if (done) break;
    }
    if (!complete || buffer.trim()) throw new UpstreamError(502, 'Upstream stream ended prematurely');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
