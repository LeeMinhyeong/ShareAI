// Real-account probes for ADR 0021 (per-account concurrency), 0022 (Claude Code → OpenAI accounts)
// and 0023 (Codex → Anthropic accounts). They talk only to ShareAI's /v1 endpoints with a ShareAI
// *user* key; provider credentials never leave the server. Output and the saved result file are
// redacted (keys, UUIDs, org ids) so they can be shared.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CODEX_INSTRUCTIONS = 'You are a helpful assistant.';

export function redact(value, limit = 300) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-…')
    .replace(/\buser_[A-Za-z0-9_-]{4,}/g, 'user_…')
    .replace(/\b(?:Bearer)\s+\S+/gi, 'Bearer …')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\borg-[A-Za-z0-9]{4,}/g, 'org-…')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<jwt>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

const weatherFn = { type: 'function', name: 'get_weather', description: 'Current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const weatherTool = { name: 'get_weather', description: 'Current weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const echoTool = { type: 'custom', name: 'echo_text', description: 'Echo raw text back. Send only the text itself as the input.', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[a-z ]+/' } };
const userText = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

export function createProber({ base, key, log = console.log, now = () => Date.now() }) {
  const results = [];
  const record = (id, verdict, what, detail = '') => {
    const row = { id, verdict, what, detail: redact(detail) };
    results.push(row);
    log(`${verdict.padEnd(4)} ${id.padEnd(30)} ${what}${row.detail ? ` — ${row.detail}` : ''}`);
    return row;
  };

  async function call(path, body) {
    const started = now();
    let res;
    try {
      res = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      return { status: 0, text: `cannot reach ${base} (is the server running?)`, started, ended: now() };
    }
    // Headers arrive once ShareAI has a slot and the provider started answering (used for overlap).
    const headersAt = now();
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json, started, headersAt, ended: now() };
  }
  const why = r => r.status === 0 ? r.text : `HTTP ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 300)}`;
  const items = r => Array.isArray(r.json?.output) ? r.json.output : [];
  const thought = list => list.some(i => i.type === 'reasoning' && String(i.encrypted_content ?? '').startsWith('srx1:'));
  // An incomplete response counts only when it produced output (the request format was accepted).
  // Reasoning alone (the budget ran out while thinking) does not show the request worked.
  const produced = r => items(r).some(i => (i.type === 'message' && (i.content ?? []).some(c => typeof c.text === 'string' && c.text.trim())) || i.type === 'function_call' || i.type === 'custom_tool_call');
  const okResponse = r => r.status === 200 && (r.json?.status === 'completed' || (r.json?.status === 'incomplete' && produced(r)));
  const textOf = r => items(r).filter(i => i.type === 'message').flatMap(i => i.content ?? []).map(c => c.text ?? '').join('');
  const note = r => r.json?.status === 'incomplete' ? `, incomplete (${r.json?.incomplete_details?.reason ?? '?'})` : '';
  // Event lines only: model text inside data lines cannot fake or spoil the verdict.
  const streamDone = r => r.status === 200 && /^event: response\.completed\r?$/m.test(r.text) && !/^event: (?:error|response\.failed)\r?$/m.test(r.text);
  // The model may answer without the tool by chance; one retry before calling it a failure.
  const withTool = async (send, pick) => { let r = await send(), hit = okResponse(r) && pick(r), retried = false; if (okResponse(r) && !hit) { retried = true; r = await send(); hit = okResponse(r) && pick(r); } return [r, hit, retried]; };
  const ms = r => `${((r.ended - r.started) / 1000).toFixed(1)}s`;

  // ADR 0023: Codex-shaped requests with a Claude model on /v1/responses.
  async function claude(models) {
    if (!models.length) throw new Error('usage: probe claude <claude-model> [more models]');
    let firstLoop;
    for (const model of models) {
      const R = body => call('/v1/responses', { model, store: false, max_output_tokens: 4096, ...body });
      const tag = s => `${model} ${s}`;

      const basic = await R({ input: [userText('Reply with exactly: OK')] });
      okResponse(basic) && /\bOK\b/i.test(textOf(basic)) ? record(tag('basic'), 'PASS', 'plain request (adaptive thinking, model default effort)', ms(basic) + note(basic))
        : record(tag('basic'), 'FAIL', 'plain request', okResponse(basic) ? `no OK in the answer: ${JSON.stringify(textOf(basic)).slice(0, 80)}` : why(basic));

      for (const effort of ['low', 'medium', 'high', 'xhigh', 'none']) {
        const r = await R({ input: [userText('What is 17*23? Answer with the number only.')], reasoning: { effort } });
        const sent = effort === 'none' ? 'thinking off' : `effort ${effort === 'xhigh' ? 'max' : effort}`;
        if (!okResponse(r)) record(tag(`effort ${effort}`), 'FAIL', `reasoning.effort=${effort} → ${sent}`, why(r));
        else if (effort === 'none' && thought(items(r))) record(tag(`effort ${effort}`), 'FAIL', `reasoning.effort=${effort} → ${sent}`, 'thinking came back although it was turned off');
        else record(tag(`effort ${effort}`), 'PASS', `reasoning.effort=${effort} → ${sent}`, `${ms(r)}, thinking shown: ${thought(items(r)) ? 'yes' : 'no'}${note(r)}`);
      }

      const ask = userText('Call get_weather for Seoul, then tell me the weather in one sentence.');
      const [t1, , t1Retried] = await withTool(() => R({ input: [ask], tools: [weatherFn], reasoning: { effort: 'medium' } }), r => items(r).some(i => i.type === 'function_call'));
      const call1 = items(t1).find(i => i.type === 'function_call');
      if (!okResponse(t1) || !call1) {
        record(tag('tool call'), 'FAIL', 'model calls a function tool', okResponse(t1) ? 'the model answered without calling the tool twice; run the probe again' : why(t1));
      } else {
        const withThinking = thought(items(t1));
        record(tag('tool call'), 'PASS', 'model calls a function tool', `thinking envelope: ${withThinking ? 'yes' : 'no (later thinking checks are weaker)'}${t1Retried ? ' (retried)' : ''}`);
        const history = [ask, ...items(t1), { type: 'function_call_output', call_id: call1.call_id, output: 'Seoul: 21C, clear sky' }];
        const t2 = await R({ input: history, tools: [weatherFn], reasoning: { effort: 'medium' } });
        okResponse(t2) ? record(tag('tool result'), 'PASS', 'tool result sent back with the replayed thinking signature', ms(t2))
          : record(tag('tool result'), 'FAIL', 'tool result sent back with the replayed thinking signature', why(t2));
        if (withThinking) {
          const extra = [{ type: 'function_call', call_id: 'probe_call_2', name: 'get_weather', arguments: '{"city":"Busan"}' }, { type: 'function_call_output', call_id: 'probe_call_2', output: 'Busan: 18C, cloudy' }];
          const t3 = await R({ input: [...history, ...extra], tools: [weatherFn], reasoning: { effort: 'medium' } });
          okResponse(t3) ? record(tag('mid-loop no thinking'), 'PASS', 'a later tool call without thinking in the same turn is accepted', ms(t3))
            : record(tag('mid-loop no thinking'), 'FAIL', 'a later tool call without thinking in the same turn is accepted (ADR 0023 assumption)', why(t3));
        } else record(tag('mid-loop no thinking'), 'SKIP', 'needs a thinking envelope in the tool call turn');
        if (firstLoop && firstLoop.model !== model) {
          const sw = await R({ input: firstLoop.history, tools: [weatherFn], reasoning: { effort: 'medium' } });
          okResponse(sw) ? record(tag('model switch'), 'PASS', `continues a ${firstLoop.model} tool turn (its thinking is dropped)`, ms(sw))
            : record(tag('model switch'), 'FAIL', `continues a ${firstLoop.model} tool turn`, why(sw));
        }
        firstLoop ??= { model, history };
      }

      const ask2 = userText('Call the echo_text tool with the input: hello world');
      const [c1, , c1Retried] = await withTool(() => R({ input: [ask2], tools: [echoTool], reasoning: { effort: 'low' } }), r => items(r).some(i => i.type === 'custom_tool_call'));
      const custom = items(c1).find(i => i.type === 'custom_tool_call');
      if (!okResponse(c1) || !custom || typeof custom.input !== 'string') {
        record(tag('freeform tool'), 'FAIL', 'model calls a freeform (apply_patch-style) tool', okResponse(c1) ? 'the model answered without calling the tool twice; run the probe again' : why(c1));
      } else {
        record(tag('freeform tool'), 'PASS', 'model calls a freeform (apply_patch-style) tool', `input: ${JSON.stringify(custom.input).slice(0, 60)}${c1Retried ? ' (retried)' : ''}`);
        const c2 = await R({ input: [ask2, ...items(c1), { type: 'custom_tool_call_output', call_id: custom.call_id, output: 'hello world' }], tools: [echoTool], reasoning: { effort: 'low' } });
        okResponse(c2) ? record(tag('freeform result'), 'PASS', 'freeform tool result sent back', ms(c2)) : record(tag('freeform result'), 'FAIL', 'freeform tool result sent back', why(c2));
      }

      const s = await R({ input: [userText('Reply with exactly: OK')], stream: true });
      const done = streamDone(s);
      done ? record(tag('stream'), 'PASS', 'streamed response ends with response.completed', ms(s))
        : record(tag('stream'), 'FAIL', 'streamed response ends with response.completed', s.status === 200 ? `last event: ${redact((s.text.match(/event: [\w.]+/g) ?? ['none']).at(-1))}` : why(s));
    }
  }

  // ADR 0022: Claude Code-shaped requests with an OpenAI model on /v1/messages, plus /v1/chat/completions.
  async function gpt(models) {
    if (!models.length) throw new Error('usage: probe gpt <openai-model> [more models]');
    for (const model of models) {
      const M = (body, name = model) => call('/v1/messages', { model: name, max_tokens: 2048, ...body });
      const text = r => (r.json?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
      const tag = s => `${model} ${s}`;
      const basic = await M({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
      basic.status === 200 && basic.json?.type === 'message' ? record(tag('messages basic'), 'PASS', '/v1/messages answered by an OpenAI account', `${ms(basic)}, text: ${JSON.stringify(text(basic)).slice(0, 40)}`)
        : record(tag('messages basic'), 'FAIL', '/v1/messages answered by an OpenAI account', why(basic));
      const suffix = await M({ messages: [{ role: 'user', content: 'What is 17*23? Answer with the number only.' }] }, `${model}(high)`);
      suffix.status === 200 ? record(tag('messages (high)'), 'PASS', `model name suffix ${model}(high)`, ms(suffix)) : record(tag('messages (high)'), 'FAIL', `model name suffix ${model}(high)`, why(suffix));
      const ask = { role: 'user', content: 'Call get_weather for Seoul, then tell me the weather in one sentence.' };
      let t1 = await M({ messages: [ask], tools: [weatherTool] });
      if (t1.status === 200 && !(t1.json?.content ?? []).some(b => b.type === 'tool_use')) t1 = await M({ messages: [ask], tools: [weatherTool] });
      const use = (t1.json?.content ?? []).find(b => b.type === 'tool_use');
      if (t1.status !== 200 || !use) record(tag('messages tool call'), 'FAIL', 'model calls a tool', t1.status === 200 ? 'the model answered without calling the tool twice; run the probe again' : why(t1));
      else {
        record(tag('messages tool call'), 'PASS', 'model calls a tool', ms(t1));
        const t2 = await M({ messages: [ask, { role: 'assistant', content: t1.json.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'Seoul: 21C, clear sky' }] }], tools: [weatherTool] });
        t2.status === 200 ? record(tag('messages tool result'), 'PASS', 'tool result sent back', ms(t2)) : record(tag('messages tool result'), 'FAIL', 'tool result sent back', why(t2));
      }
      const chat = await call('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
      chat.status === 200 && typeof chat.json?.choices?.[0]?.message?.content === 'string' ? record(tag('chat completions'), 'PASS', '/v1/chat/completions with an OpenAI model', ms(chat))
        : record(tag('chat completions'), 'FAIL', '/v1/chat/completions with an OpenAI model', why(chat));
    }
  }

  // ADR 0021: n simultaneous requests; with one active account they must share it.
  async function parallel(model, n) {
    if (!model || !Number.isInteger(n) || n < 2 || n > 16) throw new Error('usage: probe parallel <model> [2-16]');
    const prompt = 'Count from 1 to 60, one number per line, nothing else.';
    const claudeModel = /^claude-/i.test(model);
    const one = () => claudeModel
      // Claude: the ADR 0023 path without thinking (adds the Claude Code identity for subscriptions).
      ? call('/v1/responses', { model, store: false, stream: true, max_output_tokens: 1024, input: [userText(prompt)], reasoning: { effort: 'none' } })
      // OpenAI: the plain Codex request shape on /v1/responses.
      : call('/v1/responses', { model, instructions: CODEX_INSTRUCTIONS, store: false, stream: true, input: [userText(prompt)] });
    const rs = await Promise.all(Array.from({ length: n }, one));
    const good = streamDone;
    // Overlap means every request was already being answered before the first one finished; a queue would fail this.
    const overlap = Math.max(...rs.map(r => r.headersAt)) < Math.min(...rs.map(r => r.ended));
    const detail = rs.map((r, i) => `#${i + 1} ${good(r) ? 'ok' : why(r).slice(0, 120)} ${ms(r)}`).join('; ');
    record(`${model} parallel x${n}`, rs.every(good) && overlap ? 'PASS' : 'FAIL', `${n} requests at once${overlap ? ' (overlapping)' : ' (did not overlap)'}`, detail);
  }

  // Before any account is registered: what clients see from an empty pool.
  async function empty() {
    const cases = [
      ['empty messages', '/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }],
      ['empty responses', '/v1/responses', { model: 'gpt-5', instructions: CODEX_INSTRUCTIONS, input: 'hi', stream: false }],
      ['empty chat', '/v1/chat/completions', { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }],
    ];
    for (const [id, path, body] of cases) {
      const r = await call(path, body);
      record(id, r.status === 403 ? 'PASS' : 'FAIL', `${path} with no account → 403 and a message for the admin`, why(r));
    }
  }

  function save(dir, label) {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const file = join(dir, `verify-${label}-${stamp}.json`);
    writeFileSync(file, JSON.stringify({ probe: label, at: new Date().toISOString(), results }, null, 2));
    const count = v => results.filter(r => r.verdict === v).length;
    log(`\n${count('PASS')} pass, ${count('FAIL')} fail, ${count('SKIP')} skip — saved ${file}`);
    return file;
  }

  return { claude, gpt, parallel, empty, save, results };
}


// --- Codex profile for Claude models (ADR 0023) -----------------------------------------------------
// Codex 0.167 has no metadata for claude-* names and falls back to a generic tool set without
// apply_patch. A model catalog entry, cloned from a model in the user's own Codex cache (so no
// OpenAI prompt is shipped here), gives Claude models the freeform apply_patch tool, reasoning
// summaries and the effort levels the router maps (low/medium/high, xhigh → Claude max).
const DROP = ['tool_mode', 'use_responses_lite', 'multi_agent_version', 'multi_agent_reasoning_effort', 'service_tiers', 'additional_speed_tiers', 'availability_nux', 'available_access_programs', 'comp_hash', 'upgrade'];
export function buildClaudeCatalog(cache, models, { context = 200000, base } = {}) {
  const list = Array.isArray(cache?.models) ? cache.models : [];
  // The main model (lowest priority number) rather than whatever comes first in the cache.
  const candidates = list.filter(m => m.apply_patch_tool_type === 'freeform' && m.model_messages?.instructions_template && m.visibility !== 'hide')
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : 1e9) - (Number.isFinite(b.priority) ? b.priority : 1e9));
  const source = base ? list.find(m => m.slug === base) : candidates[0];
  if (!source) throw new Error(base ? `model ${base} is not in the Codex model cache` : 'no Codex model with a freeform apply_patch tool in the model cache; run codex once while signed in, or pass --base <slug>');
  if (!source.model_messages?.instructions_template && !source.base_instructions) throw new Error(`model ${source.slug} has no instructions to copy`);
  if (!models.length || models.some(m => !/^claude-[A-Za-z0-9._-]+$/.test(m))) throw new Error('model names must start with claude-');
  if (!Number.isSafeInteger(context) || context < 8192) throw new Error('--context must be an integer of at least 8192');
  const entries = models.map((slug, i) => {
    const e = structuredClone(source);
    for (const k of DROP) delete e[k];
    if (e.model_messages?.instructions_template) e.model_messages.instructions_template = e.model_messages.instructions_template.replace(/\b(an agent based on) GPT-\d+(?:\.\d+)*/g, '$1 Claude');
    Object.assign(e, {
      slug, display_name: `${slug} (ShareAI)`, description: `${slug} through ShareAI on an Anthropic account`, priority: 50 + i,
      default_reasoning_level: 'medium', default_reasoning_summary: 'auto',
      supported_reasoning_levels: [['low', 'Claude effort low'], ['medium', 'Claude effort medium'], ['high', 'Claude effort high'], ['xhigh', 'Claude effort max']].map(([effort, description]) => ({ effort, description })),
      context_window: context, max_context_window: context, experimental_supported_tools: [], supports_search_tool: false, web_search_tool_type: 'text',
      support_verbosity: false, supports_image_detail_original: false, visibility: 'list', apply_patch_tool_type: 'freeform',
    });
    return e;
  });
  return { base: source.slug, context, catalog: { models: entries } };
}

export function claudeProfileToml({ model, catalogPath, baseUrl, context = 200000 }) {
  const q = s => JSON.stringify(s); // a JSON string is a valid TOML basic string
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return [
    `model = ${q(model)}`, 'model_provider = "shareai"', 'model_reasoning_effort = "medium"', `model_catalog_json = ${q(catalogPath.replace(/\\/g, '/'))}`,
    // Codex counts tokens its own way; compact well before Claude's real window.
    `model_context_window = ${context}`, `model_auto_compact_token_limit = ${Math.floor(context * 0.8)}`, '',
    '[model_providers.shareai]', 'name = "ShareAI"', `base_url = ${q(root + '/v1')}`, 'env_key = "SHAREAI_API_KEY"', 'wire_api = "responses"',
    'supports_websockets = false', 'capabilities.remote_compaction = "unsupported"', '',
  ].join('\n');
}
