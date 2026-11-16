// ADR 0022: Claude Code (Anthropic Messages on /v1/messages) → OpenAI accounts (Responses API).
// Request translation, Responses-stream → Messages-stream translation and error envelopes.
// The shared pipeline (forward-chat.ts) still owns selection, fences, timers, settlement and usage.
import { createHash, randomUUID } from 'crypto';
import { UpstreamError } from './inference.js';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type Effort = typeof EFFORTS[number];
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
/** Anthropic's effort scale tops out at `max`; OpenAI's highest level is `xhigh`. */
const effortOf = (v: unknown): Effort | undefined => v === 'max' ? 'xhigh' : isEffort(v) ? v : undefined;

/** `gpt-5.1-codex(high)` → base `gpt-5.1-codex`, effort `high`. Any other parenthesised suffix is part of the name. */
export function splitModel(model: string): { base: string; effort?: Effort } {
  const m = /^(.+?)\(([a-z]+)\)$/i.exec(model.trim());
  const effort = m ? effortOf(m[2].toLowerCase()) : undefined;
  if (m && effort) return { base: m[1].trim(), effort };
  return { base: model.trim() };
}

/** ADR 0022 decision 2: the model the client chose decides; only OpenAI model names cross. */
export function isOpenAIModel(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  return /^(?:gpt-|chatgpt-|codex-|o\d)/i.test(splitModel(model).base);
}

const bad = (message: string): never => { throw new UpstreamError(400, message); };
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** OpenAI function names: kept when valid, otherwise a deterministic, bounded replacement. */
export function wireToolName(name: string): string {
  if (WIRE_NAME.test(name)) return name;
  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
  return `${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 55)}_${hash}`;
}

const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Anthropic tool_use ids must match `^[A-Za-z0-9_-]+$`; other provider call ids get a stable replacement. */
export function anthropicToolUseId(callId: unknown): string {
  if (typeof callId === 'string' && TOOL_USE_ID.test(callId)) return callId;
  return `toolu_${createHash('sha256').update(String(callId), 'utf8').digest('hex').slice(0, 24)}`;
}

export type CrossRequest = {
  clientModel: string;
  model: string;
  effort?: Effort;
  maxTokens?: number;
  instructions: string;
  input: unknown[];
  tools?: unknown[];
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  /** wire name → name the client declared */
  toolNames: Map<string, string>;
};

function budgetEffort(budget: unknown): Effort | undefined {
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return undefined;
  if (budget <= 1024) return 'low';
  if (budget <= 10240) return 'medium';
  if (budget < 131072) return 'high';
  return 'xhigh';
}

function imageUrl(block: any): string {
  const s = block.source;
  if (isObject(s) && s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') return `data:${s.media_type};base64,${s.data}`;
  if (isObject(s) && s.type === 'url' && typeof s.url === 'string') return s.url;
  return bad('Unsupported image source for an OpenAI model');
}

const REJECTED_FIELDS = ['stop_sequences', 'mcp_servers', 'container'];

/** Validates and translates everything that does not depend on the account (ADR 0022 decisions 3–5). */
export function prepareCross(body: any): CrossRequest {
  if (!isObject(body)) bad('Request body must be a JSON object');
  const { base, effort: suffix } = splitModel(body.model);
  for (const key of REJECTED_FIELDS) {
    const v = body[key];
    if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) bad(`${key} is not supported for OpenAI models`);
  }
  let instructions = '';
  if (typeof body.system === 'string') instructions = body.system;
  else if (Array.isArray(body.system)) {
    instructions = body.system.map((b: any) => isObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : bad('system must contain only text blocks for OpenAI models'))
      // Claude Code's own billing marker means nothing to OpenAI.
      .filter((text: string) => !text.startsWith('x-anthropic-billing-header:')).join('\n\n');
  } else if (body.system !== undefined && body.system !== null) bad('system must be a string or text blocks');

  // Tool names: declared tools and history tool_use names share one mapping.
  const toolNames = new Map<string, string>();
  const mapName = (name: unknown): string => {
    if (typeof name !== 'string' || !name) return bad('tool name must be a non-empty string');
    const wire = wireToolName(name);
    const prior = toolNames.get(wire);
    if (prior !== undefined && prior !== name) bad('Two tool names collide after translation for OpenAI models');
    toolNames.set(wire, name);
    return wire;
  };

  let tools: unknown[] | undefined;
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) bad('tools must be an array');
    tools = [];
    for (const t of body.tools) {
      if (!isObject(t)) bad('tools must contain objects');
      // Server tools (web_search, bash, text_editor, computer, code_execution, ...) have no OpenAI
      // counterpart here; their definitions are dropped (decision 5).
      if (t.type !== undefined && t.type !== 'custom') continue;
      const parameters = t.input_schema === undefined ? { type: 'object', properties: {} } : t.input_schema;
      if (!isObject(parameters)) bad('tool input_schema must be an object');
      tools.push({ type: 'function', name: mapName(t.name), ...(typeof t.description === 'string' ? { description: t.description } : {}), parameters, strict: false });
    }
    if (!tools.length) tools = undefined;
  }

  let toolChoice: unknown, parallelToolCalls: boolean | undefined;
  if (isObject(body.tool_choice)) {
    const c = body.tool_choice;
    if (c.type === 'auto') toolChoice = 'auto';
    else if (c.type === 'any') toolChoice = 'required';
    else if (c.type === 'none') toolChoice = 'none';
    else if (c.type === 'tool') toolChoice = { type: 'function', name: mapName(c.name) };
    else bad('Unsupported tool_choice for OpenAI models');
    if (c.disable_parallel_tool_use === true) parallelToolCalls = false;
    if (!tools && toolChoice !== 'none' && toolChoice !== 'auto') bad('tool_choice requires tools');
    // Every declared tool may have been a dropped server tool: then there is nothing to choose from.
    if (!tools) { toolChoice = undefined; parallelToolCalls = undefined; }
  } else if (body.tool_choice !== undefined && body.tool_choice !== null) bad('tool_choice must be an object');

  const input: unknown[] = [];
  if (!Array.isArray(body.messages) || !body.messages.length) bad('messages must be a non-empty array');
  for (const m of body.messages) {
    // Claude Code (2.1.3xx) sends mid-conversation `system` messages (environment, reminders). They keep
    // their position as Responses developer messages; only text can be carried.
    if (isObject(m) && m.role === 'system') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : bad('message content must be a string or an array');
      const texts = blocks.map((b: any) => isObject(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : bad('system messages may contain only text for OpenAI models')).filter((s: string) => s);
      if (texts.length) input.push({ type: 'message', role: 'developer', content: texts.map((text: string) => ({ type: 'input_text', text })) });
      continue;
    }
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant')) bad('messages must have role user, assistant or system');
    const role = m.role as 'user' | 'assistant';
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : bad('message content must be a string or an array');
    let parts: unknown[] = [];
    // Images from tool results follow the whole run of function_call_output items, never split it.
    let toolImages: unknown[] = [];
    const flushImages = () => { if (toolImages.length) { input.push({ type: 'message', role: 'user', content: toolImages }); toolImages = []; } };
    const flush = () => { if (parts.length) { input.push({ type: 'message', role, content: parts }); parts = []; } };
    for (const b of blocks) {
      if (!isObject(b) || typeof b.type !== 'string') bad('content blocks must be objects with a type');
      if (b.type !== 'tool_result') flushImages();
      switch (b.type) {
        case 'text':
          if (typeof b.text !== 'string') bad('text block requires text');
          parts.push({ type: role === 'user' ? 'input_text' : 'output_text', text: b.text });
          break;
        case 'image':
          if (role !== 'user') bad('images are supported only in user messages for OpenAI models');
          parts.push({ type: 'input_image', image_url: imageUrl(b) });
          break;
        case 'thinking': case 'redacted_thinking':
          if (role !== 'assistant') bad('thinking blocks belong to assistant messages');
          break; // decision 4: never sent to OpenAI
        case 'tool_use':
          if (role !== 'assistant') bad('tool_use belongs to assistant messages');
          if (typeof b.id !== 'string' || !b.id) bad('tool_use requires an id');
          flush();
          input.push({ type: 'function_call', call_id: b.id, name: mapName(b.name), arguments: JSON.stringify(b.input ?? {}) });
          break;
        case 'tool_result': {
          if (role !== 'user') bad('tool_result belongs to user messages');
          if (typeof b.tool_use_id !== 'string' || !b.tool_use_id) bad('tool_result requires tool_use_id');
          flush();
          const content = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content === undefined ? [] : Array.isArray(b.content) ? b.content : bad('tool_result content must be a string or an array');
          const texts: string[] = [], images: unknown[] = [];
          for (const c of content) {
            if (isObject(c) && c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
            else if (isObject(c) && c.type === 'image') images.push({ type: 'input_image', image_url: imageUrl(c) });
            // Claude Code tool search returns references to deferred tools; every tool is already declared here.
            else if (isObject(c) && c.type === 'tool_reference' && typeof (c.tool_name ?? c.name) === 'string') texts.push(`Tool loaded: ${c.tool_name ?? c.name}`);
            else bad('tool_result may contain only text and images for OpenAI models');
          }
          const text = texts.join('\n');
          input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error === true ? `[tool error] ${text}` : text });
          toolImages.push(...images);
          break;
        }
        default:
          // document, server_tool_use, *_tool_result, search_result, container_upload, ...: content would be lost.
          bad(`${String(b.type).slice(0, 64)} blocks are not supported for OpenAI models`);
      }
    }
    flushImages();
    flush();
  }

  let effort: Effort | undefined = suffix;
  if (!effort && isObject(body.output_config)) effort = effortOf(body.output_config.effort);
  if (!effort && isObject(body.thinking) && body.thinking.type === 'enabled') effort = budgetEffort(body.thinking.budget_tokens);

  let maxTokens: number | undefined;
  if (body.max_tokens !== undefined) {
    if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) bad('max_tokens must be a positive integer');
    maxTokens = body.max_tokens;
  }
  return { clientModel: body.model, model: base, effort, maxTokens, instructions, input, tools, toolChoice, parallelToolCalls, toolNames };
}

/** The Responses request for one account kind (ADR 0022: Codex OAuth gets no output cap and a default instruction). */
export function buildResponsesBody(cross: CrossRequest, kind: 'api_key' | 'oauth'): Record<string, unknown> {
  return {
    model: cross.model,
    instructions: cross.instructions || (kind === 'oauth' ? 'You are a helpful assistant.' : undefined),
    input: cross.input,
    ...(cross.tools ? { tools: cross.tools } : {}),
    ...(cross.toolChoice !== undefined ? { tool_choice: cross.toolChoice } : {}),
    ...(cross.parallelToolCalls !== undefined ? { parallel_tool_calls: cross.parallelToolCalls } : {}),
    ...(cross.effort ? { reasoning: { effort: cross.effort } } : {}),
    ...(kind === 'api_key' && cross.maxTokens !== undefined ? { max_output_tokens: cross.maxTokens } : {}),
    stream: true,
    store: false,
  };
}

// ---------------------------------------------------------------------------
// Responses stream → Anthropic Messages stream

export type AnthropicEvent = { type: string; [key: string]: unknown };
export const sseOf = (e: AnthropicEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** Parses the data of one validated SSE frame; comment-only frames give undefined. */
export function frameEvent(raw: string): any {
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
  }
  if (!data.length) return undefined;
  return JSON.parse(data.join('\n'));
}

const unsupported = (): never => { throw Object.assign(new UpstreamError(502, 'Upstream returned output Claude Code cannot represent'), { translationLimit: true as const }); };

export class MessagesFromResponses {
  private started = false;
  private index = -1;
  private open: { kind: 'text' | 'tool'; itemId: string } | undefined;
  private toolCalls = 0;
  private argsSent = new Set<string>();
  private readonly id = `msg_${randomUUID().replace(/-/g, '')}`;
  constructor(private readonly clientModel: string, private readonly toolNames: Map<string, string>) {}

  private start(out: AnthropicEvent[]) {
    if (this.started) return;
    this.started = true;
    out.push({ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.clientModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  private close(out: AnthropicEvent[]) {
    if (this.open) { out.push({ type: 'content_block_stop', index: this.index }); this.open = undefined; }
  }
  private text(out: AnthropicEvent[], itemId: string, text: string) {
    // Never an empty text block: Anthropic rejects one if the history later goes to a Claude model.
    if (!text) return;
    if (!this.open || this.open.kind !== 'text' || this.open.itemId !== itemId) {
      this.close(out);
      this.index++; this.open = { kind: 'text', itemId };
      out.push({ type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
    }
    out.push({ type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text } });
  }

  /** One non-terminal Responses event → Anthropic events. */
  push(e: any): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    if (!isObject(e)) return out;
    this.start(out);
    switch (e.type) {
      case 'response.output_item.added': {
        const item = e.item;
        if (!isObject(item)) unsupported();
        if (item.type === 'message' || item.type === 'reasoning') break;
        if (item.type !== 'function_call') unsupported();
        if (typeof item.name !== 'string' || typeof item.id !== 'string') unsupported();
        this.close(out);
        this.index++; this.open = { kind: 'tool', itemId: item.id }; this.toolCalls++;
        out.push({ type: 'content_block_start', index: this.index, content_block: { type: 'tool_use', id: anthropicToolUseId(item.call_id ?? item.id), name: this.toolNames.get(item.name) ?? item.name, input: {} } });
        if (typeof item.arguments === 'string' && item.arguments) { this.argsSent.add(item.id); out.push({ type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: item.arguments } }); }
        break;
      }
      case 'response.output_text.delta': case 'response.refusal.delta':
        if (typeof e.delta !== 'string') unsupported();
        this.text(out, String(e.item_id ?? ''), e.delta);
        break;
      case 'response.function_call_arguments.delta':
        if (typeof e.delta !== 'string' || !this.open || this.open.kind !== 'tool' || this.open.itemId !== e.item_id) unsupported();
        if (e.delta) { this.argsSent.add(e.item_id); out.push({ type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: e.delta } }); }
        break;
      case 'response.output_item.done': {
        const item = e.item;
        if (!isObject(item)) unsupported();
        if (item.type === 'function_call' && this.open?.kind === 'tool' && this.open.itemId === item.id) {
          // Some backends send the arguments only with the finished item.
          if (!this.argsSent.has(item.id) && typeof item.arguments === 'string' && item.arguments) out.push({ type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: item.arguments } });
          this.close(out);
        } else if (item.type === 'function_call' && !this.argsSent.has(item.id) && typeof item.arguments === 'string' && item.arguments) {
          // Its block was already closed by another item: these arguments can no longer be shown.
          unsupported();
        } else if (item.type === 'message' && this.open?.kind === 'text' && this.open.itemId === item.id) this.close(out);
        else if (item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'function_call') unsupported();
        break;
      }
      default: break; // created, in_progress, content_part.*, *.done, reasoning summaries, annotations
    }
    return out;
  }

  /** The terminal Responses event → closing Anthropic events (message_delta then message_stop). */
  finish(e: any): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    this.start(out);
    this.close(out);
    const r = isObject(e?.response) ? e.response : {};
    let stop: string;
    if (e?.type === 'response.incomplete') { const reason = r.incomplete_details?.reason; stop = reason === 'max_output_tokens' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : 'end_turn'; }
    else stop = this.toolCalls ? 'tool_use' : 'end_turn';
    const u = isObject(r.usage) ? r.usage : {};
    const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const cached = Math.min(count(u.input_tokens_details?.cached_tokens), count(u.input_tokens));
    out.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { input_tokens: count(u.input_tokens) - cached, output_tokens: count(u.output_tokens), cache_read_input_tokens: cached, cache_creation_input_tokens: 0 } });
    out.push({ type: 'message_stop' });
    return out;
  }

  /** A complete Responses JSON object (stream not honoured) → the same Anthropic events. */
  fromJson(value: any): AnthropicEvent[] {
    if (!isObject(value) || !Array.isArray(value.output)) unsupported();
    const out: AnthropicEvent[] = [];
    for (const item of value.output) {
      if (!isObject(item)) unsupported();
      if (item.type === 'reasoning') continue;
      if (item.type === 'message') {
        for (const c of Array.isArray(item.content) ? item.content : []) {
          if (isObject(c) && (c.type === 'output_text' || c.type === 'refusal')) out.push(...this.push({ type: 'response.output_text.delta', item_id: item.id ?? 'm', delta: String(c.text ?? c.refusal ?? '') }));
        }
        out.push(...this.push({ type: 'response.output_item.done', item: { type: 'message', id: item.id ?? 'm' } }));
      } else if (item.type === 'function_call') {
        out.push(...this.push({ type: 'response.output_item.added', item }));
        out.push(...this.push({ type: 'response.output_item.done', item }));
      } else unsupported();
    }
    out.push(...this.finish({ type: value.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: value }));
    return out;
  }
}

/** Folds Anthropic stream events into one Messages API response object (client asked for stream: false). */
export function aggregateMessage(events: AnthropicEvent[]): Record<string, unknown> {
  let message: any;
  const blocks: any[] = []; const json: string[] = [];
  for (const e of events) {
    if (e.type === 'message_start') message = { ...(e.message as object) };
    else if (e.type === 'content_block_start') { blocks[e.index as number] = { ...(e.content_block as object) }; json[e.index as number] = ''; }
    else if (e.type === 'content_block_delta') {
      const d: any = e.delta, b = blocks[e.index as number];
      if (d.type === 'text_delta') b.text += d.text; else json[e.index as number] += d.partial_json;
    } else if (e.type === 'message_delta') { message.stop_reason = (e.delta as any).stop_reason; message.stop_sequence = null; message.usage = e.usage; }
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]?.type === 'tool_use') {
      try { blocks[i].input = json[i] ? JSON.parse(json[i]) : {}; } catch { throw Object.assign(new UpstreamError(502, 'Upstream returned invalid tool arguments'), { translationLimit: true as const }); }
    }
  }
  return { ...message, content: blocks };
}

// ---------------------------------------------------------------------------
// Errors

const anthropicType = (status: number) => status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
  : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : 'api_error';

function providerMessage(value: any): string | undefined {
  const m = value?.error?.message ?? value?.response?.error?.message ?? value?.message ?? value?.detail;
  if (typeof m !== 'string' || !m) return undefined;
  // Claude Code starts compacting on "prompt is too long"; OpenAI reports the same condition by code.
  const code = value?.error?.code ?? value?.response?.error?.code;
  return (code === 'context_length_exceeded' && !/prompt is too long/i.test(m) ? `prompt is too long: ${m}` : m).slice(0, 4096);
}

/** OpenAI HTTP error body → Anthropic error envelope; the provider's message is kept (ADR 0019 3B). */
export function anthropicErrorFromOpenAI(status: number, body: Buffer | string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); } catch { value = undefined; }
  return { type: 'error', error: { type: anthropicType(status), message: providerMessage(value) ?? `Upstream returned HTTP ${status}` } };
}

/** OpenAI in-stream failure frame → Anthropic error object (the body of a JSON reply or an `error` event). */
export function anthropicErrorFromOpenAIFrame(raw: string, status: number): AnthropicEvent {
  let value: unknown;
  try { value = frameEvent(raw); } catch { value = undefined; }
  return { type: 'error', error: { type: anthropicType(status), message: providerMessage(value) ?? 'Upstream reported a stream failure' } };
}

/** Response headers relayed on the cross path: request ids and retry guidance only (no pooled-account usage headers). */
export const crossRelayedHeader = (name: string) => ['request-id', 'x-request-id', 'retry-after', 'x-should-retry'].includes(name);

/** Interval for `ping` events while the provider sends nothing the client can see (reasoning, keep-alives). */
export const CROSS_PING = { ms: 10_000 };
