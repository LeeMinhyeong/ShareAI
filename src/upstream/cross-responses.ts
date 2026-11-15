// ADR 0023: Codex (OpenAI Responses on /v1/responses) → Anthropic accounts (Messages API).
// Request translation, Messages-stream → Responses-stream translation and error envelopes.
// The shared pipeline (forward-chat.ts) still owns selection, fences, timers, settlement and usage.
import { randomUUID } from 'crypto';
import { UpstreamError } from './inference.js';
import { EFFORTS, wireToolName, anthropicToolUseId, frameEvent } from './cross-messages.js';

export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
/** Prefix of the router's envelope inside a Codex reasoning item's `encrypted_content`. */
export const REASONING_PREFIX = 'srx1:';
export const DEFAULT_MAX_TOKENS = 32000;

type Level = typeof EFFORTS[number] | 'max';
type AnthropicEffort = 'low' | 'medium' | 'high' | 'max';
const LEVELS = new Set<string>([...EFFORTS, 'max']);

const bad = (message: string): never => { throw new UpstreamError(400, message); };
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `claude-sonnet-4-5(high)` → base `claude-sonnet-4-5`, level `high`. Unknown suffixes stay part of the name. */
export function splitClaudeModel(model: string): { base: string; level?: Level } {
  const m = /^(.+?)\(([a-z]+)\)$/i.exec(model.trim());
  if (m && LEVELS.has(m[2].toLowerCase())) return { base: m[1].trim(), level: m[2].toLowerCase() as Level };
  return { base: model.trim() };
}

/** ADR 0023: a Claude model name on /v1/responses crosses to Anthropic accounts. */
export function isClaudeModel(model: unknown): boolean {
  return typeof model === 'string' && /^claude-/i.test(splitClaudeModel(model).base);
}

/** Decision 2: Codex levels onto Claude Code's adaptive-thinking effort scale; `none` turns thinking off. */
function anthropicEffort(level: unknown): AnthropicEffort | null | undefined {
  if (level === 'none') return null;
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return 'high';
  if (level === 'xhigh' || level === 'max') return 'max';
  return undefined;
}

// --- Reasoning envelope (decision 1) -------------------------------------------------------------

type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };

/** The generating model is recorded: a signature is only replayed to the same model (review: model switches). */
export function encodeReasoning(blocks: ThinkingBlock[], model?: string): string {
  return REASONING_PREFIX + Buffer.from(JSON.stringify({ v: 1, ...(model ? { model } : {}), blocks }), 'utf8').toString('base64');
}
const MAX_ENVELOPE = 4 * 1024 * 1024;

/** Blocks carried in a router envelope; undefined for anything else (OpenAI ciphertext, tampering). */
export function decodeReasoning(value: unknown, model?: string): ThinkingBlock[] | undefined {
  if (typeof value !== 'string' || !value.startsWith(REASONING_PREFIX) || value.length > MAX_ENVELOPE) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(Buffer.from(value.slice(REASONING_PREFIX.length), 'base64').toString('utf8')); } catch { return undefined; }
  if (!isObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.blocks)) return undefined;
  if (model !== undefined && parsed.model !== undefined && String(parsed.model).toLowerCase() !== model.toLowerCase()) return undefined;
  const blocks: ThinkingBlock[] = [];
  for (const b of parsed.blocks) {
    if (isObject(b) && b.type === 'thinking' && typeof b.thinking === 'string' && typeof b.signature === 'string' && b.signature) blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
    else if (isObject(b) && b.type === 'redacted_thinking' && typeof b.data === 'string' && b.data) blocks.push({ type: 'redacted_thinking', data: b.data });
    else return undefined;
  }
  return blocks;
}

// --- Request -------------------------------------------------------------------------------------

export type ToolIdentity = { kind: 'function' | 'custom'; name: string; namespace?: string };

export type ResponsesCross = {
  clientModel: string;
  model: string;
  thinking: boolean;
  effort?: AnthropicEffort;
  maxTokens: number;
  system: string[];
  messages: { role: 'user' | 'assistant'; content: any[] }[];
  tools?: any[];
  toolChoice?: any;
  /** wire name → what Codex declared */
  toolMap: Map<string, ToolIdentity>;
};

function imageBlock(url: unknown): Record<string, unknown> {
  if (typeof url !== 'string' || !url) return bad('input_image requires image_url for Claude models');
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return bad('Unsupported image URL for Claude models');
}

const formatText = (format: unknown): string => {
  if (!isObject(format) || format.type === 'text') return '';
  if (format.type === 'grammar' && typeof format.definition === 'string') {
    return `\n\nThe input is raw text (not JSON) in this ${typeof format.syntax === 'string' ? format.syntax : ''} grammar:\n${format.definition}`;
  }
  return bad('Unsupported custom tool format for Claude models');
};

// web_search_call only records the search; its findings are in the assistant message that follows (dropped, not refused).
const DROPPED_HISTORY = /^(?:web_search_call)$/;
const HOSTED_HISTORY = /^(?:local_shell_call|local_shell_call_output|image_generation_call|code_interpreter_call|file_search_call|computer_call|computer_call_output|tool_search_call|tool_search_output|mcp_\w+|compaction|compaction_trigger|item_reference)$/;

/** Validates and translates everything that does not depend on the account (ADR 0023). */
export function prepareResponsesCross(body: any): ResponsesCross {
  if (!isObject(body)) bad('Request body must be a JSON object');
  const { base, level: suffix } = splitClaudeModel(body.model);
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) bad('previous_response_id is not supported for Claude models');
  // A structured output request would silently become free text (codex exec --output-schema).
  if (isObject(body.text) && isObject(body.text.format) && body.text.format.type !== 'text') bad('text.format is not supported for Claude models');

  const toolMap = new Map<string, ToolIdentity>();
  const mapTool = (id: ToolIdentity): string => {
    if (typeof id.name !== 'string' || !id.name) bad('tool name must be a non-empty string');
    if (id.namespace !== undefined && (typeof id.namespace !== 'string' || !id.namespace)) bad('tool namespace must be a non-empty string');
    const wire = wireToolName(id.namespace ? `${id.namespace}__${id.name}` : id.name);
    const prior = toolMap.get(wire);
    if (prior && (prior.name !== id.name || prior.namespace !== id.namespace || prior.kind !== id.kind)) bad('Two tools collide after translation for Claude models');
    if (!prior) toolMap.set(wire, id);
    return wire;
  };

  // Tools first, so declared kinds win over history.
  let tools: any[] | undefined;
  const addTool = (t: any, namespace?: string) => {
    if (!isObject(t)) bad('tools must contain objects');
    if (t.type === 'function') {
      const schema = isObject(t.parameters) ? (t.parameters.type === undefined ? { type: 'object', ...t.parameters } : t.parameters) : { type: 'object', properties: {} };
      if (schema.type !== 'object') bad('function parameters must be an object schema for Claude models');
      tools!.push({ name: mapTool({ kind: 'function', name: t.name, ...(namespace ? { namespace } : {}) }), ...(typeof t.description === 'string' ? { description: t.description } : {}), input_schema: schema });
    } else if (t.type === 'custom') {
      const description = `${typeof t.description === 'string' ? t.description : ''}${formatText(t.format)}`.trim();
      tools!.push({ name: mapTool({ kind: 'custom', name: t.name, ...(namespace ? { namespace } : {}) }), ...(description ? { description } : {}), input_schema: { type: 'object', properties: { input: { type: 'string', description: 'The raw tool input, exactly as the tool description specifies.' } }, required: ['input'] } });
    } else if (t.type === 'namespace' && !namespace) {
      if (typeof t.name !== 'string' || !t.name || !Array.isArray(t.tools)) bad('namespace tools require a name and tools');
      for (const child of t.tools) addTool(child, t.name);
    }
    // web_search, local_shell, image_generation, file_search, tool_search, ...: no Claude counterpart here; dropped.
  };
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) bad('tools must be an array');
    tools = [];
    for (const t of body.tools) addTool(t);
    if (!tools.length) tools = undefined;
  }

  let toolChoice: any, forced = false;
  const c = body.tool_choice;
  if (c === 'auto' || c === undefined || c === null) toolChoice = undefined;
  else if (c === 'none') toolChoice = { type: 'none' };
  else if (c === 'required') { toolChoice = { type: 'any' }; forced = true; }
  else if (isObject(c) && (c.type === 'function' || c.type === 'custom')) {
    toolChoice = { type: 'tool', name: mapTool({ kind: c.type, name: c.name, ...(c.namespace ? { namespace: c.namespace } : {}) }) }; forced = true;
  } else bad('Unsupported tool_choice for Claude models');
  if (forced && !tools) bad('tool_choice requires tools');
  if (!tools) toolChoice = undefined;
  if (body.parallel_tool_calls === false && tools && toolChoice?.type !== 'none') toolChoice = { ...(toolChoice ?? { type: 'auto' }), disable_parallel_tool_use: true };

  // Items → messages. Same-role neighbours merge into one message.
  const system: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions);
  const messages: { role: 'user' | 'assistant'; content: any[] }[] = [];
  // Anthropic rejects text blocks that are empty or whitespace only.
  const visible = (b: any) => b.type !== 'text' || (typeof b.text === 'string' && b.text.trim() !== '');
  const append = (role: 'user' | 'assistant', blocks: any[]) => {
    blocks = blocks.filter(visible);
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks); else messages.push({ role, content: [...blocks] });
  };
  let pendingThinking: ThinkingBlock[] = [];
  const assistant = (blocks: any[]) => { append('assistant', [...pendingThinking, ...blocks]); pendingThinking = []; };
  const user = (blocks: any[]) => {
    pendingThinking = [];
    const last = messages.at(-1);
    // Anthropic wants tool results first in their user message; text that arrived earlier moves behind them.
    if (blocks.length && blocks.every(b => b.type === 'tool_result') && last?.role === 'user') {
      const at = last.content.findIndex(b => b.type !== 'tool_result');
      if (at >= 0) { last.content.splice(at, 0, ...blocks); return; }
    }
    append('user', blocks);
  };

  const items = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : bad('input must be a string or an array');
  for (const item of items) {
    if (!isObject(item)) bad('input items must be objects');
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (type === 'message') {
      const role = item.role;
      const parts = typeof item.content === 'string' ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: item.content }] : Array.isArray(item.content) ? item.content : bad('message content must be a string or an array');
      if (role === 'system' || role === 'developer') {
        const text = parts.map((p: any) => isObject(p) && (p.type === 'input_text' || p.type === 'text') && typeof p.text === 'string' ? p.text : bad(`${role} messages may contain only text for Claude models`)).join('\n');
        if (!text.trim()) { /* nothing to say */ } else if (!messages.length) system.push(text); else user([{ type: 'text', text }]);
      } else if (role === 'user') {
        user(parts.map((p: any) => {
          if (isObject(p) && (p.type === 'input_text' || p.type === 'text') && typeof p.text === 'string') return { type: 'text', text: p.text };
          if (isObject(p) && p.type === 'input_image') return p.file_id ? bad('input_image file_id is not supported for Claude models') : imageBlock(p.image_url);
          return bad(`${isObject(p) ? String(p.type).slice(0, 64) : 'unknown'} content is not supported for Claude models`);
        }).filter((b: any) => b.type !== 'text' || b.text));
      } else if (role === 'assistant') {
        assistant(parts.map((p: any) => {
          if (isObject(p) && p.type === 'output_text' && typeof p.text === 'string') return { type: 'text', text: p.text };
          if (isObject(p) && p.type === 'refusal' && typeof p.refusal === 'string') return { type: 'text', text: p.refusal };
          return bad('assistant messages may contain only text for Claude models');
        }).filter((b: any) => b.text));
      } else bad('message role must be system, developer, user or assistant');
    } else if (type === 'reasoning') {
      // Decision 1: only the router's own envelope carries Claude thinking; OpenAI ciphertext is dropped.
      const blocks = decodeReasoning(item.encrypted_content, base);
      if (blocks) pendingThinking.push(...blocks);
    } else if (type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id) bad('function_call requires call_id');
      let input: unknown = {};
      if (typeof item.arguments === 'string' && item.arguments.trim()) { try { input = JSON.parse(item.arguments); } catch { bad('function_call arguments must be JSON for Claude models'); } }
      if (!isObject(input)) bad('function_call arguments must be a JSON object for Claude models');
      assistant([{ type: 'tool_use', id: anthropicToolUseId(item.call_id), name: mapTool({ kind: 'function', name: item.name, ...(item.namespace ? { namespace: item.namespace } : {}) }), input }]);
    } else if (type === 'custom_tool_call') {
      if (typeof item.call_id !== 'string' || !item.call_id) bad('custom_tool_call requires call_id');
      if (typeof item.input !== 'string') bad('custom_tool_call requires input');
      assistant([{ type: 'tool_use', id: anthropicToolUseId(item.call_id), name: mapTool({ kind: 'custom', name: item.name, ...(item.namespace ? { namespace: item.namespace } : {}) }), input: { input: item.input } }]);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (typeof item.call_id !== 'string' || !item.call_id) bad(`${type} requires call_id`);
      const out = item.output;
      let content: string | any[];
      if (typeof out === 'string') content = out;
      else if (Array.isArray(out)) content = out.map((p: any) => {
        if (isObject(p) && (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') return { type: 'text', text: p.text };
        if (isObject(p) && p.type === 'input_image') return imageBlock(p.image_url);
        return bad('tool output may contain only text and images for Claude models');
      }).filter((b: any) => b.type !== 'text' || b.text.trim());
      else bad(`${type} output must be a string or an array`);
      user([{ type: 'tool_result', tool_use_id: anthropicToolUseId(item.call_id), content: content! }]);
    } else if (typeof type === 'string' && DROPPED_HISTORY.test(type)) {
      // nothing to send
    } else if (typeof type === 'string' && HOSTED_HISTORY.test(type)) bad(`${type} items are not supported for Claude models`);
    else bad(`${String(type).slice(0, 64)} items are not supported for Claude models`);
  }
  if (!messages.length || messages[0].role !== 'user') bad('input must start with a user item for Claude models');

  const level = suffix ?? (isObject(body.reasoning) && body.reasoning.effort != null ? body.reasoning.effort : undefined);
  const effort = anthropicEffort(level);
  if (level !== undefined && effort === undefined) bad('Unsupported reasoning.effort for Claude models');
  // With thinking on, Anthropic requires the assistant turn being continued with tool results to start with its
  // thinking. History from a GPT turn (or a dropped envelope) has none: that one request runs without thinking.
  // The turn being continued starts at the first assistant message after the last user message without tool results.
  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && !messages[i].content.some(b => b.type === 'tool_result')) { turnStart = i; break; }
  const opening = messages[turnStart + 1];
  const continuesWithoutThinking = !!messages.at(-1)?.content.some(b => b.type === 'tool_result') && messages.at(-1)?.role === 'user'
    && opening?.role === 'assistant' && opening.content[0]?.type !== 'thinking' && opening.content[0]?.type !== 'redacted_thinking';
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
    if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1) bad('max_output_tokens must be a positive integer');
    maxTokens = body.max_output_tokens;
  }
  return {
    clientModel: body.model, model: base,
    // Anthropic does not accept thinking with a forced tool choice; that one request runs without it.
    thinking: effort !== null && !forced && !continuesWithoutThinking,
    ...(effort ? { effort } : {}),
    maxTokens, system, messages, tools, toolChoice, toolMap,
  };
}

const CACHE = { type: 'ephemeral' };
function markLast(blocks: any[]): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type !== 'thinking' && blocks[i].type !== 'redacted_thinking') { blocks[i] = { ...blocks[i], cache_control: CACHE }; return true; }
  }
  return false;
}

/** The Messages request for one account kind, with automatic cache breakpoints (decisions 4 and 5). */
export function buildMessagesBody(cross: ResponsesCross, kind: 'api_key' | 'oauth'): Record<string, unknown> {
  const system = [...(kind === 'oauth' ? [CLAUDE_CODE_SYSTEM] : []), ...cross.system].map(text => ({ type: 'text', text }));
  const messages = cross.messages.map(m => ({ role: m.role, content: m.content.map(b => ({ ...b })) }));
  const tools = cross.tools?.map(t => ({ ...t }));
  let marks = 0;
  if (tools?.length) { tools[tools.length - 1].cache_control = CACHE; marks++; }
  if (system.length) { (system[system.length - 1] as any).cache_control = CACHE; marks++; }
  if (marks < 4 && messages.length && markLast(messages[messages.length - 1].content)) marks++;
  for (let i = messages.length - 2; marks < 4 && i >= 0; i--) {
    if (messages[i].role === 'user') { if (markLast(messages[i].content)) marks++; break; }
  }
  return {
    model: cross.model,
    max_tokens: cross.maxTokens,
    ...(system.length ? { system } : {}),
    messages,
    ...(tools ? { tools } : {}),
    ...(cross.toolChoice ? { tool_choice: cross.toolChoice } : {}),
    ...(cross.thinking ? { thinking: { type: 'adaptive' } } : {}),
    // Effort is independent of thinking: a request that runs without thinking keeps the client's level (re-review).
    ...(cross.effort ? { output_config: { effort: cross.effort } } : {}),
    stream: true,
  };
}

/** Upstream headers for the cross request (decision 5 mirrors the /v1/chat/completions path for OAuth). */
export function crossAnthropicHeaders(kind: 'api_key' | 'oauth'): Record<string, string> {
  return kind === 'oauth'
    ? { 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14', 'user-agent': 'claude-cli/2.1.0' }
    : { 'anthropic-beta': 'interleaved-thinking-2025-05-14' };
}

// --- Anthropic stream → Responses stream ---------------------------------------------------------

export type ResponsesEvent = { type: string; [key: string]: unknown };
const unsupported = (): never => { throw new UpstreamError(502, 'Upstream returned output Codex cannot represent'); };
const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;

type Block =
  | { kind: 'thinking'; itemId: string; out: number; text: string; signature: string; summary: boolean }
  | { kind: 'redacted'; itemId: string; out: number; data: string }
  | { kind: 'text'; itemId: string; out: number; text: string }
  | { kind: 'tool'; itemId: string; out: number; args: string; item: Record<string, any>; custom: boolean };

export class ResponsesFromMessages {
  private readonly id = `resp_${randomUUID().replace(/-/g, '')}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private started = false;
  private seq = 0;
  private n = 0;
  private output: any[] = [];
  private blocks = new Map<number, Block>();
  private stop: string | undefined;
  private usage = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  constructor(private readonly clientModel: string, private readonly toolMap: Map<string, ToolIdentity>, private readonly model?: string) {}

  private ev(type: string, fields: Record<string, unknown>): ResponsesEvent { return { type, sequence_number: this.seq++, ...fields }; }
  private shell(status: string) { return { id: this.id, object: 'response', created_at: this.createdAt, status, model: this.clientModel }; }
  private start(out: ResponsesEvent[]) {
    if (this.started) return;
    this.started = true;
    out.push(this.ev('response.created', { response: { ...this.shell('in_progress'), output: [] } }));
    out.push(this.ev('response.in_progress', { response: { ...this.shell('in_progress'), output: [] } }));
  }
  private absorbUsage(u: any) {
    if (!isObject(u)) return;
    if ('input_tokens' in u) this.usage.input = count(u.input_tokens);
    if ('cache_creation_input_tokens' in u) this.usage.cacheCreate = count(u.cache_creation_input_tokens);
    if ('cache_read_input_tokens' in u) this.usage.cacheRead = count(u.cache_read_input_tokens);
    if ('output_tokens' in u) this.usage.output = count(u.output_tokens);
  }

  /** One non-terminal Anthropic event → Responses events. */
  push(e: any): ResponsesEvent[] {
    const out: ResponsesEvent[] = [];
    if (!isObject(e)) return out;
    this.start(out);
    switch (e.type) {
      case 'message_start': this.absorbUsage(e.message?.usage); break;
      case 'content_block_start': {
        const b = e.content_block, index = e.index;
        if (!Number.isSafeInteger(index) || this.blocks.has(index) || !isObject(b)) unsupported();
        const out_index = this.output.length; this.output.push(null);
        const n = this.n++;
        if (b.type === 'thinking') {
          const block: Block = { kind: 'thinking', itemId: `rs_${this.id.slice(5)}_${n}`, out: out_index, text: '', signature: typeof b.signature === 'string' ? b.signature : '', summary: false };
          this.blocks.set(index, block);
          out.push(this.ev('response.output_item.added', { output_index: out_index, item: { id: block.itemId, type: 'reasoning', summary: [] } }));
          if (typeof b.thinking === 'string' && b.thinking) out.push(...this.thinkingDelta(block, b.thinking));
        } else if (b.type === 'redacted_thinking') {
          if (typeof b.data !== 'string' || !b.data) unsupported();
          const block: Block = { kind: 'redacted', itemId: `rs_${this.id.slice(5)}_${n}`, out: out_index, data: b.data };
          this.blocks.set(index, block);
          out.push(this.ev('response.output_item.added', { output_index: out_index, item: { id: block.itemId, type: 'reasoning', summary: [] } }));
        } else if (b.type === 'text') {
          const block: Block = { kind: 'text', itemId: `msg_${this.id.slice(5)}_${n}`, out: out_index, text: '' };
          this.blocks.set(index, block);
          out.push(this.ev('response.output_item.added', { output_index: out_index, item: { id: block.itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }));
          out.push(this.ev('response.content_part.added', { item_id: block.itemId, output_index: out_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
          if (typeof b.text === 'string' && b.text) { block.text += b.text; out.push(this.ev('response.output_text.delta', { item_id: block.itemId, output_index: out_index, content_index: 0, delta: b.text })); }
        } else if (b.type === 'tool_use') {
          if (typeof b.id !== 'string' || typeof b.name !== 'string') unsupported();
          const id: ToolIdentity = this.toolMap.get(b.name) ?? { kind: 'function', name: b.name };
          const custom = id.kind === 'custom';
          const item: Record<string, any> = custom
            ? { id: `ctc_${this.id.slice(5)}_${n}`, type: 'custom_tool_call', status: 'in_progress', call_id: b.id, name: id.name, input: '' }
            : { id: `fc_${this.id.slice(5)}_${n}`, type: 'function_call', status: 'in_progress', call_id: b.id, name: id.name, arguments: '' };
          if (id.namespace) item.namespace = id.namespace;
          this.blocks.set(index, { kind: 'tool', itemId: item.id, out: out_index, args: '', item, custom });
          out.push(this.ev('response.output_item.added', { output_index: out_index, item: { ...item } }));
        } else unsupported(); // server tool use, tool results, ...
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks.get(e.index), d = e.delta;
        if (!block || !isObject(d)) unsupported();
        if (d.type === 'thinking_delta' && block!.kind === 'thinking' && typeof d.thinking === 'string') out.push(...this.thinkingDelta(block!, d.thinking));
        else if (d.type === 'signature_delta' && block!.kind === 'thinking' && typeof d.signature === 'string') block!.signature += d.signature;
        else if (d.type === 'text_delta' && block!.kind === 'text' && typeof d.text === 'string') {
          if (d.text) { block!.text += d.text; out.push(this.ev('response.output_text.delta', { item_id: block!.itemId, output_index: block!.out, content_index: 0, delta: d.text })); }
        } else if (d.type === 'input_json_delta' && block!.kind === 'tool' && typeof d.partial_json === 'string') {
          block!.args += d.partial_json;
          if (!block!.custom && d.partial_json) out.push(this.ev('response.function_call_arguments.delta', { item_id: block!.itemId, output_index: block!.out, delta: d.partial_json }));
        } else if (d.type === 'citations_delta' && block!.kind === 'text') { /* citations have no Codex counterpart */ }
        else unsupported();
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(e.index);
        if (!block) unsupported();
        this.blocks.delete(e.index);
        out.push(...this.closeBlock(block!));
        break;
      }
      case 'message_delta':
        if (isObject(e.delta) && typeof e.delta.stop_reason === 'string') this.stop = e.delta.stop_reason;
        this.absorbUsage(e.usage);
        break;
      default: break; // ping and unknown informational events
    }
    return out;
  }

  private thinkingDelta(block: Extract<Block, { kind: 'thinking' }>, text: string): ResponsesEvent[] {
    const out: ResponsesEvent[] = [];
    if (!text) return out;
    if (!block.summary) {
      block.summary = true;
      out.push(this.ev('response.reasoning_summary_part.added', { item_id: block.itemId, output_index: block.out, summary_index: 0, part: { type: 'summary_text', text: '' } }));
    }
    block.text += text;
    out.push(this.ev('response.reasoning_summary_text.delta', { item_id: block.itemId, output_index: block.out, summary_index: 0, delta: text }));
    return out;
  }

  private closeBlock(block: Block): ResponsesEvent[] {
    const out: ResponsesEvent[] = [];
    let item: any;
    if (block.kind === 'thinking') {
      if (!block.signature) unsupported(); // an unsigned block could not be replayed to Anthropic
      if (block.summary) {
        out.push(this.ev('response.reasoning_summary_text.done', { item_id: block.itemId, output_index: block.out, summary_index: 0, text: block.text }));
        out.push(this.ev('response.reasoning_summary_part.done', { item_id: block.itemId, output_index: block.out, summary_index: 0, part: { type: 'summary_text', text: block.text } }));
      }
      item = { id: block.itemId, type: 'reasoning', summary: block.text ? [{ type: 'summary_text', text: block.text }] : [], encrypted_content: encodeReasoning([{ type: 'thinking', thinking: block.text, signature: block.signature }], this.model) };
    } else if (block.kind === 'redacted') {
      item = { id: block.itemId, type: 'reasoning', summary: [], encrypted_content: encodeReasoning([{ type: 'redacted_thinking', data: block.data }], this.model) };
    } else if (block.kind === 'text') {
      out.push(this.ev('response.output_text.done', { item_id: block.itemId, output_index: block.out, content_index: 0, text: block.text }));
      out.push(this.ev('response.content_part.done', { item_id: block.itemId, output_index: block.out, content_index: 0, part: { type: 'output_text', text: block.text, annotations: [] } }));
      item = { id: block.itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: block.text, annotations: [] }] };
    } else if (block.custom) {
      let input: unknown;
      try { input = JSON.parse(block.args || '{}').input; } catch { input = undefined; }
      if (typeof input !== 'string') unsupported();
      out.push(this.ev('response.custom_tool_call_input.delta', { item_id: block.itemId, output_index: block.out, delta: input }));
      out.push(this.ev('response.custom_tool_call_input.done', { item_id: block.itemId, output_index: block.out, input }));
      item = { ...block.item, status: 'completed', input };
    } else {
      const args = block.args || '{}';
      out.push(this.ev('response.function_call_arguments.done', { item_id: block.itemId, output_index: block.out, arguments: args }));
      item = { ...block.item, status: 'completed', arguments: args };
    }
    this.output[block.out] = item;
    out.push(this.ev('response.output_item.done', { output_index: block.out, item }));
    return out;
  }

  /** The terminal Anthropic event (message_stop) → `response.completed` or `response.incomplete`. */
  finish(): ResponsesEvent[] {
    const out: ResponsesEvent[] = [];
    this.start(out);
    if (this.blocks.size) unsupported();
    const input = this.usage.input + this.usage.cacheCreate + this.usage.cacheRead;
    const usage = { input_tokens: input, input_tokens_details: { cached_tokens: this.usage.cacheRead }, output_tokens: this.usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + this.usage.output };
    const complete = this.stop === undefined || this.stop === 'end_turn' || this.stop === 'tool_use' || this.stop === 'stop_sequence';
    const reason = this.stop === 'max_tokens' ? 'max_output_tokens' : this.stop === 'refusal' ? 'content_filter' : this.stop;
    const response = { ...this.shell(complete ? 'completed' : 'incomplete'), output: this.output.filter(Boolean), usage, ...(complete ? {} : { incomplete_details: { reason } }) };
    out.push(this.ev(complete ? 'response.completed' : 'response.incomplete', { response }));
    return out;
  }
}

/** The final Response object from a translated event list (client asked for stream: false). */
export function aggregateResponse(events: ResponsesEvent[]): Record<string, unknown> {
  const last = events.at(-1);
  if (!last || (last.type !== 'response.completed' && last.type !== 'response.incomplete')) throw new UpstreamError(502, 'Malformed or incomplete upstream stream');
  return last.response as Record<string, unknown>;
}

// --- Errors --------------------------------------------------------------------------------------

function codeFor(status: number, message: string): string {
  if (status === 429) return 'rate_limit_exceeded';
  if (status === 529 || status === 503) return 'server_is_overloaded';
  if (status === 400 && /prompt is too long|context window|too many tokens/i.test(message)) return 'context_length_exceeded';
  if (status === 401) return 'invalid_api_key';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'server_error';
}
function anthropicMessage(value: any): { type?: string; message?: string } {
  const e = value?.error;
  return { type: typeof e?.type === 'string' ? e.type : undefined, message: typeof e?.message === 'string' && e.message ? e.message.slice(0, 4096) : undefined };
}

/** Anthropic HTTP error body → Responses error envelope; the provider's message is kept (ADR 0019 3B). */
export function responsesErrorFromAnthropic(status: number, body: Buffer | string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); } catch { value = undefined; }
  const { type, message } = anthropicMessage(value);
  const text = message ?? `Upstream returned HTTP ${status}`;
  return { error: { message: text, type: type ?? 'api_error', code: codeFor(status, text), param: null } };
}

/** Anthropic in-stream `error` frame → Responses `response.failed` event. */
export function responsesFailedFromAnthropicFrame(raw: string, status: number): ResponsesEvent {
  let value: unknown;
  try { value = frameEvent(raw); } catch { value = undefined; }
  return responsesFailed(status, anthropicMessage(value).message ?? 'Upstream reported a stream failure');
}

/** A `response.failed` event (also used for router-made failures on an open Codex stream). */
export function responsesFailed(status: number, message: string, code = codeFor(status, message)): ResponsesEvent {
  return { type: 'response.failed', response: { id: `resp_${randomUUID().replace(/-/g, '')}`, object: 'response', status: 'failed', error: { code, message } } };
}
