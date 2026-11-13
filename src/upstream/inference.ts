import type { ResolvedAuth } from './tokens.js';

export type ChatRequest = { model: string; messages: {role:string; content:string}[]; temperature?: number; max_tokens?: number };
export type InferenceEvent = { text?: string; id?: string; finish?: string; usage?: {input:number; output:number} };
// The event contract requires both counts. Partial or invalid usage is unknown,
// not a verified zero; omit it rather than manufacture the missing count.
function validTokenUsage(input: unknown, output: unknown): boolean {
  return typeof input === 'number' && typeof output === 'number'
    && Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
    && Number.isSafeInteger(input + output);
}
function usageAccumulator() {
  let seen = false, ambiguous = false;
  let value: InferenceEvent['usage'];
  return {
    observe(input: unknown, output: unknown) {
      if (!validTokenUsage(input, output)) ambiguous = true;
      else if (seen && (value?.input !== input || value?.output !== output)) ambiguous = true;
      else if (!seen) value = {input:input as number, output:output as number};
      seen = true;
    },
    get: () => ambiguous ? undefined : value,
  };
}
export class UpstreamError extends Error {
  headers?: Record<string, string>;
  constructor(public status: number, message: string, headers?: Record<string, string>) { super(message); this.headers = headers; }
}

type Auth = Omit<ResolvedAuth, 'observedAccount'> | {kind:'siwc'; token:string};
const strictStarts = new WeakSet<Function>();
const verified429s = new WeakMap<Error, Function>();
const siwcStream429s = new WeakSet<Error>();
export const isSiwcStream429 = (error: unknown) => error instanceof Error && siwcStream429s.has(error);
export const isStrictInference = (start: Function) => strictStarts.has(start);
export const isVerifiedUpstream429 = (error: unknown, start: Function) => error instanceof UpstreamError && verified429s.get(error) === start;

/** Creates a one-use experimental capability, bound to the actual HTTP parser. */
export function strictInference(provider: string, auth: Auth, request: ChatRequest, endpoint?: string, signal?: AbortSignal): () => Promise<AsyncGenerator<InferenceEvent>> {
  let used = false;
  const start = () => {
    if (used) throw new Error('Strict inference already started');
    used = true;
    return inferInternal(provider, auth, request, endpoint, signal, undefined, start);
  };
  strictStarts.add(start);
  return start;
}
export async function infer(provider: string, auth: Auth, request: ChatRequest, endpoint?: string, signal?: AbortSignal, invoke?: (start: () => Promise<Response>) => Promise<Response>): Promise<AsyncGenerator<InferenceEvent>> {
  return inferInternal(provider, auth, request, endpoint, signal, invoke, undefined);
}
async function inferInternal(provider: string, auth: Auth, request: ChatRequest, endpoint: string | undefined, signal: AbortSignal | undefined, invoke: ((start: () => Promise<Response>) => Promise<Response>) | undefined, strict: Function | undefined): Promise<AsyncGenerator<InferenceEvent>> {
  if (!['openai','anthropic'].includes(provider) || !['oauth','api_key','siwc'].includes(auth.kind) || (auth.kind === 'siwc' && (provider !== 'openai' || endpoint !== undefined)) || !auth.token || /[\r\n]/.test(auth.token)) throw new UpstreamError(400, 'Unsupported or invalid credentials');
  // Same literal as oauth.ts and passthrough.ts (a test compares them): any `sk-ant-` key except OAuth
  // tokens (oat/ort), session cookies (sid) and Admin keys. A Claude key is never sent to OpenAI.
  if (auth.kind === 'api_key' && !(provider === 'anthropic' ? /^sk-ant-(?!oat|ort|admin|sid)[A-Za-z0-9_-]+$/.test(auth.token) : auth.token.startsWith('sk-') && !auth.token.startsWith('sk-ant-'))) throw new UpstreamError(400, 'Unsupported or invalid API key');
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
  } else if (auth.kind === 'siwc') {
    if (request.temperature !== undefined || request.max_tokens !== undefined) throw new UpstreamError(400, 'SIWC does not support temperature or max_tokens');
    url = 'https://api.openai.com/v1/responses';
    headers = {'content-type':'application/json', 'authorization':`Bearer ${auth.token}`, 'accept':'text/event-stream'};
    const instructions = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    body = {model:request.model, input:request.messages.filter(m => m.role !== 'system'), ...(instructions ? {instructions} : {}), stream:true, store:false};
    protocol = 'siwc';
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
  // A request may be cancelled while credentials are being refreshed.
  signal?.throwIfAborted();
  const start = () => fetch(url, {method:'POST', headers, body:JSON.stringify(body), signal, redirect:'manual'});
  const response = await (invoke ? invoke(start) : start());
  if (!response.ok) {
    const respHeaders = Object.fromEntries(response.headers.entries());
    if (strict && response.status === 429) {
      const error = new UpstreamError(response.status, `Upstream returned HTTP ${response.status}`, respHeaders);
      verified429s.set(error, strict);
      // Disposal is best-effort and must not delay or replace a verified response.
      try { void response.body?.cancel().catch(() => {}); } catch { /* already locked or unavailable */ }
      throw error;
    }
    if (response.status === 429) {
      // The status itself is the observation; a cancelled body must not hide it.
      try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
      throw new UpstreamError(response.status, `Upstream returned HTTP ${response.status}`, respHeaders);
    }
    try { void response.body?.cancel().catch(() => {}); } catch { /* observed status is authoritative */ }
    throw new UpstreamError(response.status, `Upstream returned HTTP ${response.status}`, respHeaders);
  }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
    // Invalid headers already establish the outcome; disposal must not delay or replace it.
    try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
    throw new UpstreamError(502, 'Upstream did not return an event stream');
  }
  return strict ? parseStrictEvents(response.body, protocol, signal) : parseEvents(response.body, protocol, signal);
}

// Shared SSE data-line decoding; validation remains mode-specific.
function sseData(frame: string): string {
  return frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
}

function validResponseItem(item: any, id: string | undefined, text: string): boolean {
  const part = item?.content?.[0];
  return item?.id === id && item?.type === 'message' && item?.role === 'assistant' && item?.status === 'completed'
    && Array.isArray(item.content) && item.content.length === 1 && part?.type === 'output_text' && part.text === text
    && Array.isArray(part.annotations) && part.annotations.length === 0;
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new UpstreamError(502, 'Upstream stream aborted'));
    signal.addEventListener('abort', onAbort, {once:true});
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function* parseEvents(body: ReadableStream<Uint8Array>, protocol: string, signal?: AbortSignal): AsyncGenerator<InferenceEvent> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true});
  let buffer = '', complete = false, started = false, finished = false;
  let responseId: string | undefined, input: number | undefined, output: number | undefined;
  let pendingUsage: InferenceEvent['usage'];
  const openaiUsage = usageAccumulator();
  let openBlock: number | undefined, nextBlock = 0;
  let responseProgress = false, itemId: string | undefined, itemDone = false;
  let partState: 'none' | 'open' | 'text_done' | 'done' = 'none', responseText = '';
  const fail = (): never => { throw new UpstreamError(502, 'Malformed or incomplete upstream stream'); };
  try {
    while (true) {
      const {value, done} = await readWithAbort(reader, signal);
      buffer += decoder.decode(value, {stream:!done});
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        if (lines.every(line => !line || line.startsWith(':'))) continue;
        if (complete) fail();
        let eventName: string | undefined; const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith(':')) continue;
          const i = line.indexOf(':'); const field = i < 0 ? line : line.slice(0,i);
          let v = i < 0 ? '' : line.slice(i+1); if (v.startsWith(' ')) v = v.slice(1);
          if (field === 'data') dataLines.push(v);
          else if (field === 'event' && eventName === undefined && v) eventName = v;
          else fail();
        }
        if (!dataLines.length) fail();
        const data = dataLines.join('\n');
        if (data === '[DONE]') {
          if (protocol !== 'openai' || !started || !finished || (eventName !== undefined && eventName !== 'message')) fail();
          complete = true; continue;
        }
        let e: any; try { e = JSON.parse(data); } catch { fail(); }
        if (!e || typeof e !== 'object' || Array.isArray(e)) fail();
        if (eventName !== undefined && eventName !== (protocol === 'openai' ? 'message' : e.type)) fail();
        if (e.type === 'error' || e.type === 'response.failed' || e.error) {
          // SIWC documents usage failures as Responses response.failed events,
          // not arbitrary objects carrying an error-shaped field.
          // Trust only the narrow, validated subset used by this adapter. The
          // provider may add legitimate fields; unknown shapes remain uncertain
          // rather than being treated as definitive evidence for settlement.
          const responseError = e.type === 'response.failed' && Object.keys(e).every(k => ['type','sequence_number','response'].includes(k))
            && e.response && typeof e.response === 'object' && !Array.isArray(e.response)
            && Object.keys(e.response).every(k => ['id','status','error'].includes(k))
            && e.response.status === 'failed' && typeof e.response.id === 'string' && e.response.id.length > 0
            && Number.isSafeInteger(e.sequence_number) && e.sequence_number >= 0
            && e.response.error && typeof e.response.error === 'object' && !Array.isArray(e.response.error)
            && Object.keys(e.response.error).every(k => ['code','message'].includes(k))
            && typeof e.response.error.message === 'string'
            && (!started || e.response.id === responseId);
          const code = responseError ? e.response.error.code : undefined;
          if (protocol === 'siwc' && code === 'subscription_sharing_usage_limit_exceeded') {
            const error = new UpstreamError(429, code);
            siwcStream429s.add(error);
            throw error;
          }
          if (protocol === 'siwc' && code === 'subscription_sharing_usage_unavailable') throw new UpstreamError(503, code);
          throw new UpstreamError(502, 'Upstream stream failed');
        }
        if (protocol === 'openai') {
          if (!Array.isArray(e.choices) || e.choices.length > 1) fail();
          if (e.id !== undefined) {
            if (typeof e.id !== 'string' || (responseId !== undefined && e.id !== responseId)) fail();
            responseId = e.id;
          }
          if (!e.choices.length) { if (!finished || !e.usage) fail(); }
          else {
            const c = e.choices[0];
            if (finished || !c || (c.index !== undefined && c.index !== 0) || !c.delta || typeof c.delta !== 'object' || Array.isArray(c.delta)) fail();
            if (Object.keys(c).some(k => !['index','delta','finish_reason','logprobs'].includes(k)) || c.logprobs != null) fail();
            if (Object.keys(c.delta).some(k => !['role','content','refusal','tool_calls','function_call'].includes(k)) || c.delta.refusal != null || c.delta.tool_calls != null || c.delta.function_call != null) fail();
            if (c.delta.role != null && c.delta.role !== 'assistant') fail();
            if (c.delta.content != null && typeof c.delta.content !== 'string') fail();
            started = true;
            if (typeof c.delta.content === 'string') yield {text:c.delta.content};
            if (c.finish_reason != null) { if (!['stop','length'].includes(c.finish_reason)) fail(); finished = true; yield {finish:c.finish_reason}; }
          }
          if (typeof e.id === 'string') yield {id:e.id};
          if (e.usage != null) openaiUsage.observe(e.usage.prompt_tokens, e.usage.completion_tokens);
        } else if (protocol === 'anthropic') {
          switch(e.type) {
            case 'ping': break;
            case 'message_start': if (started || typeof e.message?.id !== 'string' || !e.message.id || !Array.isArray(e.message.content) || e.message.content.length !== 0) fail(); started = true; input = e.message.usage?.input_tokens; yield {id:e.message.id}; break;
            case 'content_block_start': if (!started || finished || openBlock !== undefined || e.index !== nextBlock || e.content_block?.type !== 'text' || typeof e.content_block.text !== 'string' || Object.keys(e.content_block).some(k => !['type','text'].includes(k))) fail(); openBlock = nextBlock; if (e.content_block.text) yield {text:e.content_block.text}; break;
            case 'content_block_delta': if (!started || finished || openBlock === undefined || e.index !== openBlock || e.delta?.type !== 'text_delta' || typeof e.delta.text !== 'string' || Object.keys(e.delta).some(k => !['type','text'].includes(k))) fail(); yield {text:e.delta.text}; break;
            case 'content_block_stop': if (!started || finished || openBlock === undefined || e.index !== openBlock) fail(); openBlock = undefined; nextBlock++; break;
            case 'message_delta': if (!started || finished || openBlock !== undefined || (nextBlock === 0 && e.delta?.stop_reason !== 'end_turn') || !['end_turn','max_tokens','stop_sequence'].includes(e.delta?.stop_reason)) fail(); finished = true; output = e.usage?.output_tokens; yield {finish:e.delta.stop_reason === 'max_tokens' ? 'length' : 'stop'}; break;
            case 'message_stop': if (!started || !finished || openBlock !== undefined) fail(); complete = true; if (validTokenUsage(input, output)) pendingUsage = {input:input!,output:output!}; break;
            default: fail();
          }
        } else {
          switch(e.type) {
            case 'response.created': if (started || !e.response || typeof e.response.id !== 'string' || !e.response.id || e.response.status !== 'in_progress') fail(); started = true; responseId = e.response.id; break;
            case 'response.in_progress': if (!started || responseProgress || itemId !== undefined || e.response?.id !== responseId || e.response?.status !== 'in_progress') fail(); responseProgress = true; break;
            case 'response.output_item.added':
              if (e.item?.type === 'reasoning') throw new UpstreamError(502, 'Upstream reasoning output is not supported by the text-only chat adapter');
              if (!started || itemId !== undefined || e.output_index !== 0 || e.item?.type !== 'message' || e.item.role !== 'assistant' || e.item.status !== 'in_progress' || typeof e.item.id !== 'string' || !e.item.id || !Array.isArray(e.item.content) || e.item.content.length) fail();
              itemId = e.item.id; break;
            case 'response.content_part.added':
              if (!itemId || itemDone || partState !== 'none' || e.item_id !== itemId || e.output_index !== 0 || e.content_index !== 0 || e.part?.type !== 'output_text' || e.part.text !== '' || !Array.isArray(e.part.annotations) || e.part.annotations.length) fail();
              partState = 'open'; break;
            case 'response.output_text.delta':
              if (partState !== 'open' || e.item_id !== itemId || e.output_index !== 0 || e.content_index !== 0 || typeof e.delta !== 'string') fail();
              responseText += e.delta; yield {text:e.delta}; break;
            case 'response.output_text.done':
              if (partState !== 'open' || e.item_id !== itemId || e.output_index !== 0 || e.content_index !== 0 || e.text !== responseText) fail();
              partState = 'text_done'; break;
            case 'response.content_part.done':
              if (partState !== 'text_done' || e.item_id !== itemId || e.output_index !== 0 || e.content_index !== 0 || e.part?.type !== 'output_text' || e.part.text !== responseText || !Array.isArray(e.part.annotations) || e.part.annotations.length) fail();
              partState = 'done'; break;
            case 'response.output_item.done':
              if (itemDone || partState !== 'done' || e.output_index !== 0 || !validResponseItem(e.item, itemId, responseText)) fail();
              itemDone = true; break;
            case 'response.completed': {
              if (!started || !itemDone || e.response?.id !== responseId || e.response?.status !== 'completed' || e.response?.error != null || e.response?.incomplete_details != null || !Array.isArray(e.response.output) || e.response.output.length !== 1 || !validResponseItem(e.response.output[0], itemId, responseText)) fail();
              complete = true; const u = e.response.usage; if (u && validTokenUsage(u.input_tokens, u.output_tokens)) pendingUsage = {input:u.input_tokens,output:u.output_tokens}; yield {id:responseId,finish:'stop'}; break;
            }
            default: fail();
          }
        }
      }
      if (done) break;
    }
    if (!complete || buffer.trim()) fail();
    if (protocol === 'openai') pendingUsage = openaiUsage.get();
    if (pendingUsage) yield {usage:pendingUsage};
  } finally {
    // Disposal is best effort; a stalled cancel cannot delay the outcome.
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
    reader.releaseLock();
  }
}

/** Experimental text-only protocol. Unknown or ambiguous events fail closed. */
async function* parseStrictEvents(body: ReadableStream<Uint8Array>, protocol: string, signal?: AbortSignal): AsyncGenerator<InferenceEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal:true});
  let buffer = '', complete = false, started = false, finish: string | undefined;
  const terminal: InferenceEvent = {};
  const textParts = new Map<string, string>();
  let input: number | undefined, output: number | undefined;
  let nextBlock = 0, openBlock: number | undefined;
  let responseId: string | undefined;
  const openaiUsage = usageAccumulator();
  const fail = (message = 'Unsupported or malformed upstream event'): never => { throw new UpstreamError(502, message); };
  try {
    while (true) {
      const {value, done} = await readWithAbort(reader, signal);
      buffer += decoder.decode(value, {stream:!done});
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        if (lines.every(line => line.startsWith(':') || line === '')) continue;
        if (complete) fail('Event after upstream terminal');
        let eventName: string | undefined;
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') dataLines.push(value);
          else if (field === 'event' && eventName === undefined && value) eventName = value;
          else fail();
        }
        if (!dataLines.length) fail();
        const data = dataLines.join('\n');
        if (data === '[DONE]') {
          if (protocol !== 'openai' || (eventName !== undefined && eventName !== 'message') || !started || !finish) fail('Upstream stream ended prematurely');
          complete = true; continue;
        }
        let e: any; try { e = JSON.parse(data); } catch { fail('Malformed upstream event'); }
        if (!e || typeof e !== 'object' || Array.isArray(e)) fail();
        if (eventName !== undefined && eventName !== (protocol === 'openai' ? 'message' : e.type)) fail();
        if (e.type === 'error' || e.type === 'response.failed' || e.error) {
          // No documented response.failed envelope here is strong enough to
          // establish a verified 429; only the actual HTTP status can do so.
          throw new UpstreamError(502, 'Upstream stream failed');
        }
        if (protocol === 'openai') {
          if (Object.keys(e).some(k => !['id','object','created','model','system_fingerprint','service_tier','choices','usage'].includes(k))) fail();
          if (!Array.isArray(e.choices) || e.choices.length > 1) fail();
          if (e.id !== undefined) { if (typeof e.id !== 'string' || (terminal.id !== undefined && terminal.id !== e.id)) fail(); terminal.id = e.id; }
          if (e.usage != null) {
            openaiUsage.observe(e.usage.prompt_tokens, e.usage.completion_tokens);
          }
          if (!e.choices.length) { if (!e.usage || !finish) fail(); continue; }
          const c = e.choices[0];
          if (!c || (c.index !== undefined && c.index !== 0) || typeof c.delta !== 'object' || c.delta === null || Array.isArray(c.delta) || finish) fail();
          if (Object.keys(c).some(k => !['index','delta','finish_reason','logprobs'].includes(k)) || c.logprobs != null) fail();
          if (Object.keys(c.delta).some(k => !['role','content','refusal','tool_calls','function_call'].includes(k)) || c.delta.refusal != null || c.delta.tool_calls != null || c.delta.function_call != null) fail();
          if (c.delta.role != null && c.delta.role !== 'assistant') fail();
          if (c.delta.content != null && typeof c.delta.content !== 'string') fail();
          started = true;
          if (typeof c.delta.content === 'string') yield {text:c.delta.content};
          if (c.finish_reason != null) { if (!['stop','length'].includes(c.finish_reason)) fail(); finish = c.finish_reason; }
        } else if (protocol === 'anthropic') {
          switch (e.type) {
            case 'ping': break;
            case 'message_start':
              if (started || !e.message || typeof e.message.id !== 'string' || !e.message.id || !Array.isArray(e.message.content) || e.message.content.length !== 0) fail();
              started = true; terminal.id = e.message.id; input = e.message.usage?.input_tokens; break;
            case 'content_block_start': if (!started || finish || openBlock !== undefined || e.index !== nextBlock || e.content_block?.type !== 'text' || typeof e.content_block.text !== 'string' || Object.keys(e.content_block).some(k => !['type','text'].includes(k))) fail(); openBlock = nextBlock; if (e.content_block.text) yield {text:e.content_block.text}; break;
            case 'content_block_delta': if (!started || finish || openBlock === undefined || e.index !== openBlock || e.delta?.type !== 'text_delta' || typeof e.delta.text !== 'string' || Object.keys(e.delta).some(k => !['type','text'].includes(k))) fail(); yield {text:e.delta.text}; break;
            case 'content_block_stop': if (!started || finish || openBlock === undefined || e.index !== openBlock) fail(); openBlock = undefined; nextBlock++; break;
            case 'message_delta': if (!started || finish || openBlock !== undefined || (nextBlock === 0 && e.delta?.stop_reason !== 'end_turn') || !['end_turn','max_tokens','stop_sequence'].includes(e.delta?.stop_reason)) fail(); finish = e.delta.stop_reason === 'max_tokens' ? 'length' : 'stop'; output = e.usage?.output_tokens; break;
            case 'message_stop': if (!started || !finish) fail(); complete = true; if (validTokenUsage(input, output)) terminal.usage = {input:input!,output:output!}; break;
            default: fail();
          }
        } else {
          switch (e.type) {
            case 'response.created':
              if (responseId !== undefined || typeof e.response?.id !== 'string' || !e.response.id || e.response.status !== 'in_progress') fail();
              responseId = e.response.id; break;
            case 'response.in_progress':
              if (!responseId || e.response?.id !== responseId || e.response.status !== 'in_progress') fail();
              break;
            case 'response.output_item.added': case 'response.output_item.done':
              if (!e.item || !['message','reasoning'].includes(e.item.type) || (e.item.content != null && (!Array.isArray(e.item.content) || e.item.content.length)) || (e.item.summary != null && (!Array.isArray(e.item.summary) || e.item.summary.length))) fail(); break;
            case 'response.content_part.added': case 'response.content_part.done':
              if (e.part?.type !== 'output_text' || (e.part.text != null && e.part.text !== (e.type === 'response.content_part.added' ? '' : textParts.get(`${e.output_index ?? 0}:${e.content_index ?? 0}`) ?? '')) || (e.part.annotations != null && (!Array.isArray(e.part.annotations) || e.part.annotations.length))) fail(); break;
            case 'response.output_text.delta': {
              if (typeof e.delta !== 'string') fail();
              const key = `${e.output_index ?? 0}:${e.content_index ?? 0}`; textParts.set(key, (textParts.get(key) ?? '') + e.delta); yield {text:e.delta}; break;
            }
            case 'response.output_text.done': if (typeof e.text !== 'string' || e.text !== (textParts.get(`${e.output_index ?? 0}:${e.content_index ?? 0}`) ?? '')) fail(); break;
            case 'response.completed':
              if (!e.response || e.response.status !== 'completed' || typeof e.response.id !== 'string' || !e.response.id || (responseId !== undefined && e.response.id !== responseId) || e.response.error != null || e.response.incomplete_details != null) fail();
              // Full response output requires reconciliation beyond this text-only adapter.
              // Reject it rather than silently discarding unsupported or unstreamed content.
              if (e.response.output != null && (!Array.isArray(e.response.output) || e.response.output.length)) fail();
              terminal.id = e.response.id; finish = 'stop'; complete = true;
              if (e.response.usage != null) { const u = e.response.usage; if (validTokenUsage(u.input_tokens, u.output_tokens)) terminal.usage = {input:u.input_tokens,output:u.output_tokens}; }
              break;
            default: fail();
          }
        }
      }
      if (done) break;
    }
    if (!complete || buffer.trim() || !finish) fail('Upstream stream ended prematurely');
    if (protocol === 'openai') { const usage = openaiUsage.get(); if (usage) terminal.usage = usage; } // usage is optional; never an explicit undefined
    yield {...terminal, finish};
  } finally { try { void reader.cancel().catch(() => {}); } catch { /* best effort */ } reader.releaseLock(); }
}
