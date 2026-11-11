/**
 * Same-protocol passthrough for Claude Code (/v1/messages) and Codex
 * (/v1/responses), ADR 0019. The request body bytes and the provider's SSE
 * frames are forwarded unchanged; the router only observes frames for terminal
 * evidence, token usage and provider-reported failures.
 */
import type { Request } from 'express';
import { UpstreamError } from './inference.js';
import type { ResolvedAuth } from './tokens.js';
import { rawBodyOf } from '../http/raw-body.js';

export type PassthroughProtocol = 'anthropic-messages' | 'responses';
export type TokenUsage = { input: number; output: number };

export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** Upper bounds for a buffered non-stream JSON reply, a provider error body and one SSE frame. */
const MAX_JSON_BODY = 32 * 1024 * 1024;
const MAX_ERROR_BODY = 1024 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;

/** Provider error response forwarded unchanged to the client (decision 3B). */
export class PassthroughHttpError extends UpstreamError {
  constructor(status: number, headers: Record<string, string>, public forwardHeaders: Record<string, string>, public body: Buffer) {
    super(status, `Upstream returned HTTP ${status}`, headers);
  }
}
/**
 * A validated provider-reported terminal failure inside a 200 stream (Anthropic
 * `error` event, Responses `response.failed`/`error`). The provider's own frame
 * was already relayed; the attempt is settled like the equivalent HTTP status.
 */
export class PassthroughStreamFailure extends UpstreamError {
  readonly providerTerminal = true;
  /** `raw` is the provider's own frame; it is written only after the attempt is settled. */
  constructor(status: number, public raw: string) { super(status, 'Upstream reported a stream failure'); }
}

export type ParsedPassthrough = {
  protocol: PassthroughProtocol;
  provider: 'anthropic' | 'openai';
  model: string;
  stream: boolean;
  body: Buffer;
  query: string;
  headers: Record<string, string>;
};

/**
 * The router must route on exactly the bytes it forwards. When the raw body is
 * available it is decoded as strict BOM-less UTF-8 and parsed again here, so
 * body-parser's charset handling (UTF-16, UTF-7, ...) can never make the routed
 * view differ from the forwarded bytes. The top-level object must not repeat a
 * key either (JSON parsers disagree on which duplicate wins). Only top-level
 * fields (model, stream, background, input, messages) drive routing; if a nested
 * field ever does, extend the duplicate check to it.
 */
function parseRawBody(raw: Buffer): any {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { throw new UpstreamError(400, 'Request body must be UTF-8 JSON'); }
  if (text.charCodeAt(0) === 0xfeff) throw new UpstreamError(400, 'Request body must not start with a byte order mark');
  let value: any;
  try { value = JSON.parse(text); } catch { throw new UpstreamError(400, 'Request body must be UTF-8 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpstreamError(400, 'Request body must be a JSON object');
  assertNoDuplicateTopLevelKeys(text);
  return value;
}

/** Scans valid JSON text (already parsed) for a repeated top-level key. Bounded; any surprise is a 400. */
export function assertNoDuplicateTopLevelKeys(text: string): void {
  const bad = (): never => { throw new UpstreamError(400, 'Request body must be UTF-8 JSON'); };
  const n = text.length;
  let i = 0;
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i++; };
  /** Advances past a string starting at i; returns its raw slice (with quotes). */
  const skipString = (): string => {
    if (text[i] !== '"') bad();
    const start = i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= n) bad();
    i++;
    return text.slice(start, i);
  };
  const skipValue = () => {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '"') { skipString(); continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (depth === 0) return; depth--; }
      else if (c === ',' && depth === 0) return;
      i++;
    }
    bad();
  };
  const keys = new Set<string>();
  ws();
  if (text[i] !== '{') bad();
  i++; ws();
  if (text[i] === '}') return;
  while (i < n) {
    ws();
    let key: string;
    try { key = JSON.parse(skipString()); } catch (error) { if (error instanceof UpstreamError) throw error; bad(); }
    if (keys.has(key!)) throw new UpstreamError(400, 'Request body repeats a top-level key');
    keys.add(key!);
    ws();
    if (text[i] !== ':') bad();
    i++; ws(); skipValue(); ws();
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '}') return;
    bad();
  }
  bad();
}

/** Validates only what routing needs; the body itself is forwarded unchanged. */
export function parsePassthrough(protocol: PassthroughProtocol, req: Request): ParsedPassthrough {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(req.headers['content-type'] ?? ''))?.[1];
  if (charset !== undefined && !/^utf-?8$/i.test(charset)) throw new UpstreamError(415, 'Request body must be UTF-8 JSON');
  const raw = rawBodyOf(req);
  const body = raw ? parseRawBody(raw) : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpstreamError(400, 'Request body must be a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) throw new UpstreamError(400, 'model must be a non-empty string');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new UpstreamError(400, 'stream must be a boolean');
  if (protocol === 'anthropic-messages' && (!Array.isArray(body.messages) || !body.messages.length)) throw new UpstreamError(400, 'messages must be a non-empty array');
  if (protocol === 'responses' && body.input === undefined) throw new UpstreamError(400, 'input is required');
  if (protocol === 'responses' && body.background === true) throw new UpstreamError(400, 'background responses are not supported');
  const queryIndex = req.originalUrl.indexOf('?');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
  }
  return {
    protocol,
    provider: protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
    model: body.model,
    stream: body.stream === true,
    body: raw ?? Buffer.from(JSON.stringify(body)),
    query: queryIndex < 0 ? '' : req.originalUrl.slice(queryIndex),
    headers,
  };
}

// Client headers forwarded upstream. Credentials, workspace/organization
// selectors, hop-by-hop and framing headers are never forwarded: the router
// supplies its own credential and the pooled account's identity.
const forwardedRequestHeader: Record<PassthroughProtocol, (name: string) => boolean> = {
  'anthropic-messages': name => name.startsWith('anthropic-') || name.startsWith('x-claude-code-') || name.startsWith('x-stainless-') || name === 'user-agent' || name === 'x-app',
  'responses': name => ['user-agent', 'originator', 'version', 'session_id', 'conversation_id', 'openai-beta'].includes(name) || name.startsWith('x-codex-') || name.startsWith('x-stainless-'),
};
const blockedRequestHeaders = new Set(['anthropic-workspace-id']);

// Response headers relayed to the client (ADR 0019 decision 4B, narrowed by review): content
// type, request ids, retry guidance and usage/rate-limit headers. Everything else, including
// organization/project identifiers of the pooled account, cookies and framing headers, is dropped.
const relayedResponseHeader = (name: string) => ['content-type', 'cache-control', 'request-id', 'x-request-id', 'retry-after', 'x-should-retry', 'openai-processing-ms'].includes(name)
  || name.startsWith('anthropic-ratelimit-') || name.startsWith('x-ratelimit-') || name.startsWith('x-codex-');
export function forwardableResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => { const n = name.toLowerCase(); if (relayedResponseHeader(n)) out[n] = value; });
  return out;
}

function mergeBeta(value: string | undefined, required: string): string {
  const parts = (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.includes(required) ? (value as string) : [...parts, required].join(',');
}

export function buildUpstreamRequest(parsed: ParsedPassthrough, auth: Pick<ResolvedAuth, 'kind' | 'token' | 'accountId'>): { url: string; headers: Record<string, string> } {
  if (!auth.token || /[\r\n]/.test(auth.token)) throw new UpstreamError(400, 'Invalid stored credentials');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.headers)) {
    if (forwardedRequestHeader[parsed.protocol](name) && !blockedRequestHeaders.has(name)) headers[name] = value;
  }
  headers['content-type'] = 'application/json';
  headers.accept = parsed.stream ? 'text/event-stream' : 'application/json';
  if (parsed.protocol === 'anthropic-messages') {
    headers['anthropic-version'] ??= '2023-06-01';
    if (auth.kind === 'api_key') {
      if (!auth.token.startsWith('sk-ant-api')) throw new UpstreamError(400, 'Unsupported or invalid API key');
      headers['x-api-key'] = auth.token;
    } else {
      headers.authorization = `Bearer ${auth.token}`;
      headers['anthropic-beta'] = mergeBeta(headers['anthropic-beta'], ANTHROPIC_OAUTH_BETA);
    }
    return { url: ANTHROPIC_MESSAGES_URL + parsed.query, headers };
  }
  headers.authorization = `Bearer ${auth.token}`;
  if (auth.kind === 'api_key') {
    if (!auth.token.startsWith('sk-')) throw new UpstreamError(400, 'Unsupported or invalid API key');
    return { url: OPENAI_RESPONSES_URL, headers };
  }
  if (!auth.accountId || /[\r\n]/.test(auth.accountId)) throw new UpstreamError(400, 'Codex OAuth requires a ChatGPT account ID');
  headers['chatgpt-account-id'] = auth.accountId;
  return { url: CODEX_RESPONSES_URL, headers };
}

async function readAbortable(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new UpstreamError(502, 'Upstream stream aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function readBounded(body: ReadableStream<Uint8Array> | null, signal: AbortSignal | undefined, limit: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await readAbortable(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new UpstreamError(502, 'Upstream response too large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
    reader.releaseLock();
  }
}

export type PassthroughResult =
  | { kind: 'stream'; status: number; headers: Record<string, string>; frames: AsyncGenerator<RelayFrame> }
  | { kind: 'json'; status: number; headers: Record<string, string>; body: Buffer; usage?: TokenUsage };
export type RelayFrame = { raw: string; terminal?: boolean; usage?: TokenUsage };

/**
 * Starts one dispatch. `invoke` is the pipeline's admission/fence wrapper; it
 * settles non-2xx statuses before returning them. A non-2xx response body is
 * buffered (bounded by the pipeline's timers through `signal`) and thrown as a
 * PassthroughHttpError so the pipeline can still refresh on 401 first.
 */
export async function startPassthrough(parsed: ParsedPassthrough, auth: Pick<ResolvedAuth, 'kind' | 'token' | 'accountId'>, signal: AbortSignal, invoke: (start: () => Promise<Response>) => Promise<Response>): Promise<PassthroughResult> {
  const { url, headers } = buildUpstreamRequest(parsed, auth);
  signal.throwIfAborted();
  const body = parsed.body;
  const response = await invoke(() => fetch(url, { method: 'POST', headers, body, signal, redirect: 'manual' }));
  const forwardHeaders = forwardableResponseHeaders(response.headers);
  if (!response.ok) {
    const rawHeaders = Object.fromEntries(response.headers.entries());
    if (response.status < 400) {
      try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
      throw new UpstreamError(502, 'Unexpected upstream redirect', rawHeaders);
    }
    let errorBody: Buffer;
    try { errorBody = await readBounded(response.body, signal, MAX_ERROR_BODY); }
    catch { throw new UpstreamError(response.status, `Upstream returned HTTP ${response.status}`, rawHeaders); }
    throw new PassthroughHttpError(response.status, rawHeaders, forwardHeaders, errorBody);
  }
  const type = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (response.body && type.includes('text/event-stream')) {
    return { kind: 'stream', status: response.status, headers: forwardHeaders, frames: relayFrames(response.body, parsed.protocol, signal) };
  }
  if (response.body && type.includes('application/json')) {
    const json = await readBounded(response.body, signal, MAX_JSON_BODY);
    return { kind: 'json', status: response.status, headers: forwardHeaders, body: json, usage: jsonTerminal(parsed.protocol, json) };
  }
  try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
  throw new UpstreamError(502, 'Upstream returned an unsupported content type');
}

const safeCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function usageOf(input: unknown[], output: unknown): TokenUsage | undefined {
  if (!input.every(safeCount) || !safeCount(output)) return undefined;
  const total = (input as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(total + output) ? { input: total, output } : undefined;
}
/** Anthropic input = uncached + cache creation + cache read (all billed input). */
function anthropicInput(u: any): unknown[] {
  if (!u || typeof u !== 'object') return [undefined];
  return [u.input_tokens, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0];
}

/** A parseable 200 JSON reply is the provider's terminal outcome; unparseable is uncertain. */
function jsonTerminal(protocol: PassthroughProtocol, body: Buffer): TokenUsage | undefined {
  let value: any;
  try { value = JSON.parse(body.toString('utf8')); } catch { throw new UpstreamError(502, 'Malformed upstream JSON response'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpstreamError(502, 'Malformed upstream JSON response');
  if (protocol === 'anthropic-messages') {
    if (value.type !== 'message' || typeof value.stop_reason !== 'string') throw new UpstreamError(502, 'Incomplete upstream message');
    return usageOf(anthropicInput(value.usage), value.usage?.output_tokens);
  }
  if (typeof value.status !== 'string' || !['completed', 'incomplete', 'failed', 'cancelled'].includes(value.status)) throw new UpstreamError(502, 'Incomplete upstream response');
  return usageOf([value.usage?.input_tokens], value.usage?.output_tokens);
}

const anthropicErrorStatus: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404,
  request_too_large: 413, rate_limit_error: 429, api_error: 500, overloaded_error: 529, timeout_error: 504,
};
function responsesFailureStatus(code: unknown): number {
  if (typeof code !== 'string') return 500;
  if (/rate_limit|usage_limit|quota/.test(code)) return 429;
  if (/server_error|overloaded|unavailable|timeout/.test(code)) return 500;
  return 400;
}

/**
 * Splits the provider stream into SSE frames and yields each one byte-for-byte
 * (UTF-8 validated). Unknown event types are forwarded; only terminal evidence
 * and failures are interpreted. Malformed data, events after the terminal and a
 * stream that ends without terminal evidence throw a generic 502 (uncertain).
 */
export async function* relayFrames(body: ReadableStream<Uint8Array>, protocol: PassthroughProtocol, signal?: AbortSignal): AsyncGenerator<RelayFrame> {
  // ignoreBOM keeps a leading BOM in the relayed bytes instead of silently dropping it.
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let buffer = '', terminal = false;
  let started = false, delta = false;
  let input: unknown[] = [undefined], output: unknown;
  const fail = (message = 'Malformed or incomplete upstream stream'): never => { throw new UpstreamError(502, message); };
  try {
    while (true) {
      const { value, done } = await readAbortable(reader, signal);
      try { buffer += decoder.decode(value, { stream: !done }); } catch { fail(); }
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index + match[0].length);
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(raw.length);
        const lines = frame.split(/\r?\n/);
        if (lines.every(line => !line || line.startsWith(':'))) { yield { raw }; continue; }
        if (terminal) fail('Event after upstream terminal');
        let eventName: string | undefined; const data: string[] = [];
        for (const line of lines) {
          if (line.startsWith(':')) continue;
          const i = line.indexOf(':'); const field = i < 0 ? line : line.slice(0, i);
          let v = i < 0 ? '' : line.slice(i + 1); if (v.startsWith(' ')) v = v.slice(1);
          if (field === 'data') data.push(v);
          else if (field === 'event') eventName = v;
          // Unknown fields are ignored, as the SSE specification requires.
        }
        if (!data.length) fail();
        let e: any;
        try { e = JSON.parse(data.join('\n')); } catch { fail(); }
        if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string') fail();
        if (eventName !== undefined && eventName !== e.type) fail();
        if (protocol === 'anthropic-messages') {
          switch (e.type) {
            case 'message_start': if (started || !e.message || typeof e.message !== 'object') fail(); started = true; input = anthropicInput(e.message.usage); break;
            case 'message_delta': if (!started) fail(); delta = true; if (e.usage && 'output_tokens' in e.usage) output = e.usage.output_tokens; break;
            case 'message_stop':
              if (!started || !delta) fail();
              terminal = true; yield { raw, terminal: true, usage: usageOf(input, output) }; continue;
            case 'error': {
              const type = e.error && typeof e.error === 'object' && typeof e.error.type === 'string' && typeof e.error.message === 'string' ? e.error.type : undefined;
              if (!type) fail();
              throw new PassthroughStreamFailure(anthropicErrorStatus[type!] ?? 500, raw);
            }
            default: break;
          }
        } else {
          switch (e.type) {
            case 'response.created': if (started) fail(); started = true; break;
            case 'response.completed': case 'response.incomplete': {
              if (!e.response || typeof e.response !== 'object') fail();
              const u = e.response.usage;
              terminal = true; yield { raw, terminal: true, usage: usageOf([u?.input_tokens], u?.output_tokens) }; continue;
            }
            case 'response.failed': {
              if (!e.response || typeof e.response !== 'object' || e.response.status !== 'failed') fail();
              throw new PassthroughStreamFailure(responsesFailureStatus(e.response.error?.code), raw);
            }
            case 'error':
              throw new PassthroughStreamFailure(responsesFailureStatus(e.code ?? e.error?.code), raw);
            default: break;
          }
        }
        yield { raw };
      }
      if (buffer.length > MAX_FRAME) fail('Upstream event too large');
      if (done) break;
    }
    if (!terminal || buffer.trim()) fail();
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
    reader.releaseLock();
  }
}

/** Router-made error in the client's protocol envelope (no provider response). */
export function routerErrorBody(protocol: PassthroughProtocol, status: number, message: string): object {
  const type = status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
    : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status === 503 || status === 529 ? 'overloaded_error' : 'api_error';
  if (protocol === 'anthropic-messages') return { type: 'error', error: { type, message } };
  return { error: { message, type, code: null, param: null } };
}

/** Router-made in-stream terminal error, used only when no provider terminal was relayed. */
export function routerErrorFrame(protocol: PassthroughProtocol, message: string): string {
  if (protocol === 'anthropic-messages') return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`;
  return `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'upstream_error', message, param: null })}\n\n`;
}
