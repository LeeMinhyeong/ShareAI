// scripts/phase5-verify.mjs probes (ADR 0021/0022/0023 real-account verification helper), run as a
// child process against the real Express v1 + admin routers over a test-owned file SQLite. The
// providers are synthetic (fetch in this process); the child talks to ShareAI over real HTTP.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'vp-admin-' + 'z'.repeat(24), LOG_LEVEL:'error', LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const {initDatabase, closeDatabase} = await import('../src/db/client.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
const {captureRawBody, JSON_BODY_LIMIT} = await import('../src/http/raw-body.ts');
const {default: v1} = await import('../src/routes/v1.ts');
const {default: admin} = await import('../src/routes/admin.ts');
const {redact} = await import('../scripts/verify-probes.mjs');
initDatabase();
const users = new UserRepository(), repo = new AccountRepository();
users.create({apiKeyHash:hashApiKey('vp-user-key'), name:'vp', email:'vp@example.invalid', tier:'pro', dailyLimit:1000});
const app = express();
app.use(express.json({limit:JSON_BODY_LIMIT, verify:captureRawBody}));
app.use('/v1', v1);
app.use('/admin', admin);
const server = http.createServer(app);
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const nativeFetch = globalThis.fetch;
const work = mkdtempSync(path.join(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : process.cwd(), 'vp-'));
after(async () => { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); closeDatabase(); try { rmSync(work, {recursive:true, force:true}); } catch { /* pruned */ } });
const script = fileURLToPath(new URL('../scripts/phase5-verify.mjs', import.meta.url));

const accounts = [];
function only(provider, credentials, extra = {}) {
  for (const a of accounts) if (a.provider === provider) repo.update(a.id, {status:'disabled'});
  const a = repo.create({name:`vp-${accounts.length}`, provider, credentialType:'api_key', credentials, ...extra});
  accounts.push(a); return a;
}

// Synthetic providers. Anthropic checks thinking signatures per model like the real API is assumed to.
let failEffortModel, calls = [], delayMs = 0, n = 0;
const sseOf = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
// With a delay, the first frame goes out at once and the rest after delayMs: the request is being answered meanwhile.
const later = async body => {
  if (!delayMs) return new Response(body, {status:200, headers:{'content-type':'text/event-stream'}});
  const cut = body.indexOf('\n\n') + 2, enc = new TextEncoder(), wait = delayMs;
  return new Response(new ReadableStream({async start(c) { c.enqueue(enc.encode(body.slice(0, cut))); await new Promise(r => setTimeout(r, wait)); c.enqueue(enc.encode(body.slice(cut))); c.close(); }}), {status:200, headers:{'content-type':'text/event-stream'}});
};
const fail = (status, message) => new Response(JSON.stringify({type:'error', error:{type:'invalid_request_error', message}}), {status, headers:{'content-type':'application/json'}});
function anthropic(body) {
  const blocks = body.messages.flatMap(m => m.content);
  if (body.thinking && blocks.some(b => b.type === 'thinking' && b.signature !== `sig-${body.model}`)) return fail(400, 'messages.1.content.0: Invalid `signature` in `thinking` block');
  if (failEffortModel === body.model && body.output_config) return fail(400, 'adaptive thinking is not supported on this model');
  const last = body.messages.at(-1);
  const wantsTool = body.tools && last.role === 'user' && !last.content.some(b => b.type === 'tool_result');
  const ev = [{type:'message_start', message:{id:'msg', type:'message', role:'assistant', model:body.model, content:[], usage:{input_tokens:5, output_tokens:1}}}];
  let i = 0;
  if (body.thinking) ev.push({type:'content_block_start', index:i, content_block:{type:'thinking', thinking:'', signature:''}}, {type:'content_block_delta', index:i, delta:{type:'thinking_delta', thinking:'plan'}}, {type:'content_block_delta', index:i, delta:{type:'signature_delta', signature:`sig-${body.model}`}}, {type:'content_block_stop', index:i++});
  if (wantsTool) {
    const tool = body.tools[0];
    ev.push({type:'content_block_start', index:i, content_block:{type:'tool_use', id:`toolu_${++n}`, name:tool.name, input:{}}}, {type:'content_block_delta', index:i, delta:{type:'input_json_delta', partial_json:JSON.stringify(tool.name === 'echo_text' ? {input:'hello world'} : {city:'Seoul'})}}, {type:'content_block_stop', index:i++});
  } else ev.push({type:'content_block_start', index:i, content_block:{type:'text', text:''}}, {type:'content_block_delta', index:i, delta:{type:'text_delta', text:'OK'}}, {type:'content_block_stop', index:i++});
  ev.push({type:'message_delta', delta:{stop_reason:wantsTool ? 'tool_use' : 'end_turn'}, usage:{output_tokens:3}}, {type:'message_stop'});
  return later(sseOf(ev));
}
function openai(url, body) {
  if (url.endsWith('/chat/completions')) return later('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1},"choices":[]}\n\ndata: [DONE]\n\n');
  const last = Array.isArray(body.input) ? body.input.at(-1) : undefined;
  const wantsTool = body.tools?.length && last?.role === 'user';
  const item = wantsTool
    ? {id:'fc_1', type:'function_call', call_id:`call_${++n}`, name:body.tools[0].name, arguments:'{"city":"Seoul"}'}
    : {id:'m1', type:'message', role:'assistant', content:[{type:'output_text', text:'OK'}]};
  const ev = [{type:'response.created', response:{id:'r', status:'in_progress'}},
    {type:'response.output_item.added', item:{...item, ...(wantsTool ? {arguments:''} : {content:[]})}},
    ...(wantsTool ? [{type:'response.function_call_arguments.delta', item_id:'fc_1', delta:item.arguments}] : [{type:'response.output_text.delta', item_id:'m1', delta:'OK'}]),
    {type:'response.output_item.done', item},
    {type:'response.completed', response:{id:'r', status:'completed', usage:{input_tokens:3, output_tokens:2}}}];
  return later(sseOf(ev));
}
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(Buffer.from(init.body).toString('utf8'));
  calls.push({url:String(url), body});
  return String(url).includes('anthropic.com') ? anthropic(body) : openai(String(url), body);
};

function run(args, {env = {}, cwd = work} = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {cwd, env:{...process.env, SHAREAI_URL:base, ADMIN_API_KEY:'', SHAREAI_API_KEY:'vp-user-key', ...env}});
    let out = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => out += c);
    child.on('close', code => resolve({code, out}));
  });
}
const lines = out => out.split(/\r?\n/).filter(l => /^(PASS|FAIL|SKIP|INFO)\b/.test(l));
const latest = label => { const dir = path.join(work, 'data'); const f = readdirSync(dir).filter(x => x.startsWith(`verify-${label}-`)).sort().at(-1); return JSON.parse(readFileSync(path.join(dir, f), 'utf8')); };

test('probe empty: no account → 403 on all three endpoints', async () => {
  const r = await run(['probe', 'empty']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(lines(r.out).map(l => l.split(/\s+/)[0]), ['PASS', 'PASS', 'PASS']);
  assert.equal(calls.length, 0);
  assert.equal(latest('empty').results.length, 3);
});

test('user --save reads the admin key from ./.env and probes use the saved key', async () => {
  writeFileSync(path.join(work, '.env'), `PORT=1\nADMIN_API_KEY="${process.env.ADMIN_API_KEY}"\n`);
  const r = await run(['user', 'monday', '--save'], {env:{SHAREAI_API_KEY:''}});
  assert.equal(r.code, 0, r.out);
  const key = readFileSync(path.join(work, 'data', 'verify-user.key'), 'utf8').trim();
  assert.ok(key.length > 10);
  assert.ok(!r.out.includes(key), 'the saved key is not printed');
  assert.equal((await run(['user', 'again', '--save'], {env:{SHAREAI_API_KEY:''}})).code, 1, 'an existing key file is not overwritten');
  only('openai', 'sk-vp-openai');
  const p = await run(['probe', 'gpt', 'gpt-6.1-terra'], {env:{SHAREAI_API_KEY:''}});
  assert.equal(p.code, 0, p.out);
  assert.match(p.out, /^active accounts: vp-\d+ \(openai api_key, x1\)$/m, 'the active accounts are shown before probing');
  assert.ok(calls.some(c => c.url === 'https://api.openai.com/v1/responses'));
});

test('probe gpt: Claude Code-shaped requests on OpenAI accounts, suffix, tool loop, chat completions', async () => {
  only('openai', 'sk-vp-openai2');
  calls = [];
  const r = await run(['probe', 'gpt', 'gpt-6.1-terra']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(lines(r.out).map(l => l.split(/\s+/)[0]), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.ok(calls.some(c => c.body.reasoning?.effort === 'high' && c.body.model === 'gpt-6.1-terra'), 'the suffix became a reasoning level');
  assert.ok(calls.some(c => c.url === 'https://api.openai.com/v1/chat/completions'));
  assert.ok(calls.some(c => c.body.input?.some?.(i => i.type === 'function_call_output')), 'the tool result went back');
});

test('probe claude: every ADR 0023 check passes and a second model exercises the model switch', async () => {
  only('anthropic', 'sk-ant-api03-vp' + 'k'.repeat(24));
  calls = [];
  const r = await run(['probe', 'claude', 'claude-opus-5-5', 'claude-haiku-5-5']);
  assert.equal(r.code, 0, r.out);
  const rows = latest('claude').results;
  assert.deepEqual(rows.filter(x => x.verdict !== 'PASS'), []);
  const ids = rows.map(x => x.id);
  for (const m of ['claude-opus-5-5', 'claude-haiku-5-5']) for (const s of ['basic', 'effort low', 'effort xhigh', 'effort none', 'tool call', 'tool result', 'mid-loop no thinking', 'freeform tool', 'freeform result', 'stream']) assert.ok(ids.includes(`${m} ${s}`), `${m} ${s}`);
  assert.ok(ids.includes('claude-haiku-5-5 model switch'));
  assert.ok(calls.some(c => c.body.output_config?.effort === 'max'));
  const toolTurn = calls.filter(c => c.body.messages.some(m => m.content.some(b => b.type === 'tool_result' && b.content === 'Seoul: 21C, clear sky')));
  assert.ok(toolTurn.some(c => c.body.thinking && c.body.messages[1].content[0].type === 'thinking'), 'the tool result turn replays the signed thinking');
  assert.ok(toolTurn.some(c => c.body.thinking && c.body.messages.some(m => m.content.some(b => b.type === 'tool_use' && b.id === 'probe_call_2'))), 'the mid-loop check sends a later call without thinking, thinking still on');
});

test('probe claude reports provider refusals as FAIL with the message and exits 1', async () => {
  failEffortModel = 'claude-sonnet-4-5';
  try {
    const r = await run(['probe', 'claude', 'claude-sonnet-4-5']);
    assert.equal(r.code, 1);
    const bad = latest('claude').results.filter(x => x.verdict === 'FAIL');
    assert.ok(bad.some(x => x.id === 'claude-sonnet-4-5 effort low' && /HTTP 400: adaptive thinking is not supported/.test(x.detail)), JSON.stringify(bad));
    assert.ok(latest('claude').results.some(x => x.id === 'claude-sonnet-4-5 effort none' && x.verdict === 'PASS'), 'thinking off has no effort to refuse');
  } finally { failEffortModel = undefined; }
});

test('probe parallel: two at once pass with concurrency 2 and fail with 1', async () => {
  delayMs = 300;
  try {
    const a = only('openai', 'sk-vp-openai3', {maxConcurrency:2});
    const ok = await run(['probe', 'parallel', 'gpt-6.1-terra', '2']);
    assert.equal(ok.code, 0, ok.out);
    assert.match(lines(ok.out)[0], /^PASS .*overlapping/);
    repo.update(a.id, {maxConcurrency:1});
    const one = await run(['probe', 'parallel', 'gpt-6.1-terra', '2']);
    assert.equal(one.code, 1, one.out);
    assert.match(lines(one.out)[0], /^FAIL /);
    only('anthropic', 'sk-ant-api03-vp2' + 'k'.repeat(24), {maxConcurrency:2});
    const c = await run(['probe', 'parallel', 'claude-opus-5-5', '2']);
    assert.equal(c.code, 0, c.out);
  } finally { delayMs = 0; }
});

test('output is redacted and usage errors are reported', async () => {
  assert.equal(redact('sk-ant-abc123456 user_xyz1234 org-abcd1234 Bearer tok 123e4567-e89b-12d3-a456-426614174000'), 'sk-… user_… org-… Bearer … <uuid>');
  assert.equal(redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_abc for a.b+c@mail.example.com'), 'token <jwt> for <email>');
  for (const args of [['probe', 'claude'], ['probe', 'parallel', 'gpt-5', '1'], ['probe', 'nope']]) {
    const r = await run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.out, /error: /);
  }
  const none = await run(['probe', 'empty'], {env:{SHAREAI_API_KEY:''}, cwd:mkdtempSync(path.join(work, 'nokey-'))});
  assert.match(none.out, /no ShareAI user key/);
  assert.ok(!existsSync(path.join(work, 'nokey-', 'data')));
});

test('the prober judges responses itself: a stream without response.completed and a non-403 empty pool fail', async () => {
  const {createProber} = await import('../scripts/verify-probes.mjs');
  const seen = [], queue = []; let busy = false;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      if (body.max_tokens === 16 || body.instructions || req.url === '/v1/chat/completions') { res.writeHead(503, {'content-type':'application/json'}); res.end('{"error":{"message":"No supported upstream account available"}}'); return; }
      if (body.model === 'claude-queue') {
        // A queueing router: the second request is answered only after the first has finished.
        const go = () => { busy = true; res.writeHead(200, {'content-type':'text/event-stream'}); setTimeout(() => { res.end('event: response.completed\ndata: {}\n\n'); busy = false; queue.shift()?.(); }, 80); };
        busy ? queue.push(go) : go(); return;
      }
if (body.model === 'claude-textual') { res.writeHead(200, {'content-type':'text/event-stream'}); res.flushHeaders(); setTimeout(() => res.end('event: response.output_text.delta\ndata: {"delta":"event: error"}\n\nevent: response.completed\ndata: {}\n\n'), 80); return; }
      if (body.stream) { res.writeHead(200, {'content-type':'text/event-stream'}); res.end('event: response.completed\ndata: {}\n\nevent: error\ndata: {"type":"error"}\n\n'); return; }
  if (body.model === 'claude-nook') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'completed', output:[{type:'message', content:[{type:'output_text', text:'nope'}]}]})); return; }
      if (body.reasoning?.effort === 'xhigh') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'incomplete', incomplete_details:{reason:'max_output_tokens'}, output:[{type:'reasoning', encrypted_content:'srx1:x'}]})); return; }
      if (body.reasoning?.effort === 'high') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'incomplete', incomplete_details:{reason:'max_output_tokens'}, output:[{type:'message', content:[{type:'output_text', text:'39'}]}]})); return; }
      if (body.reasoning?.effort === 'none') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'completed', output:[{type:'reasoning', encrypted_content:'srx1:x'}, {type:'message', content:[{type:'output_text', text:'391'}]}]})); return; }
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'completed', output:[{type:'message', content:[{type:'output_text', text:'OK'}]}]}));
    });
  });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const mocked = globalThis.fetch;
  globalThis.fetch = nativeFetch; // the prober runs in this process here, so it must reach the stub
  try {
    const p = createProber({base:`http://127.0.0.1:${stub.address().port}`, key:'k', log:() => {}});
    await p.claude(['claude-x']);
    const row = id => p.results.find(r => r.id === id);
    assert.equal(row('claude-x stream').verdict, 'FAIL', 'an error event after response.completed fails the stream');
    assert.equal(row('claude-x tool call').verdict, 'FAIL', 'no tool call is a failure');
    assert.match(row('claude-x tool call').detail, /twice/);
    assert.equal(seen.filter(b => b.tools?.[0]?.name === 'get_weather').length, 2, 'one retry before failing');
    assert.equal(row('claude-x basic').verdict, 'PASS');
    assert.equal(row('claude-x effort xhigh').verdict, 'FAIL', 'an incomplete response with reasoning only does not count');
    assert.equal(row('claude-x effort high').verdict, 'PASS', 'an incomplete response with text counts');
    assert.match(row('claude-x effort high').detail, /incomplete \(max_output_tokens\)/);
    assert.equal(row('claude-x effort none').verdict, 'FAIL', 'thinking with effort none is reported');
    assert.equal(row('claude-x effort low').verdict, 'PASS');
    await p.claude(['claude-nook']);
    assert.equal(row('claude-nook basic').verdict, 'FAIL', 'an answer without OK is not a pass');
    assert.match(row('claude-nook basic').detail, /no OK/);
    await p.parallel('claude-textual', 2);
    assert.equal(row('claude-textual parallel x2').verdict, 'PASS', 'model text that looks like an event line does not spoil the verdict');
    await p.parallel('claude-queue', 2);
    assert.equal(row('claude-queue parallel x2').verdict, 'FAIL', 'a queue is not concurrency');
    assert.match(row('claude-queue parallel x2').what, /did not overlap/);
    await p.empty();
    assert.deepEqual(p.results.filter(r => r.id.startsWith('empty')).map(r => r.verdict), ['FAIL', 'FAIL', 'FAIL']);
  } finally { globalThis.fetch = mocked; stub.closeAllConnections(); await new Promise(r => stub.close(r)); }
});

test('codex-setup clones a cached Codex model into a Claude catalog and a shareai-claude profile', async () => {
  const {buildClaudeCatalog, claudeProfileToml} = await import('../scripts/verify-probes.mjs');
  const gpt = {slug:'gpt-x', display_name:'GPT X', apply_patch_tool_type:'freeform', tool_mode:'code_mode_only', use_responses_lite:true, service_tiers:[{id:'p'}],
    supported_reasoning_levels:[{effort:'ultra', description:'u'}], context_window:500000, shell_type:'unified_exec',
    model_messages:{instructions_template:'You are Codex, an agent based on GPT-6. Work well.', approvals:{a:1}}};
  const cache = {client_version:'0.167.2', models:[{slug:'old', apply_patch_tool_type:'function'}, {...structuredClone(gpt), slug:'gpt-mini', priority:9}, {...gpt, priority:1}]};
  const {base, catalog} = buildClaudeCatalog(cache, ['claude-opus-5-5', 'claude-haiku-5-5'], {context:1000000});
  assert.equal(base, 'gpt-x');
  assert.deepEqual(catalog.models.map(m => m.slug), ['claude-opus-5-5', 'claude-haiku-5-5']);
  const m = catalog.models[0];
  assert.equal(m.apply_patch_tool_type, 'freeform');
  assert.equal(m.shell_type, 'unified_exec');
  assert.deepEqual(m.supported_reasoning_levels.map(l => l.effort), ['low', 'medium', 'high', 'xhigh'], 'only levels the router maps');
  assert.equal(m.default_reasoning_summary, 'auto');
  assert.equal(m.context_window, 1000000);
  assert.equal(m.model_messages.instructions_template, 'You are Codex, an agent based on Claude. Work well.');
  assert.deepEqual(m.model_messages.approvals, {a:1});
  for (const k of ['tool_mode', 'use_responses_lite', 'service_tiers']) assert.equal(k in m, false, k);
  assert.equal(gpt.model_messages.instructions_template, 'You are Codex, an agent based on GPT-6. Work well.', 'the cache entry is not mutated');
  assert.throws(() => buildClaudeCatalog(cache, ['gpt-5']), /claude-/);
  assert.throws(() => buildClaudeCatalog({models:[{slug:'old', apply_patch_tool_type:'function'}]}, ['claude-x']), /freeform/);
  assert.throws(() => buildClaudeCatalog(cache, ['claude-x'], {base:'nope'}), /not in the Codex model cache/);
  assert.throws(() => buildClaudeCatalog(cache, ['claude-x'], {context:100}), /--context/);
  const toml0 = claudeProfileToml({model:'claude-opus-5-5', catalogPath:'C:\\h\\o"k\\c.json', baseUrl:'http://s:20100/v1/', context:200000});
  assert.match(toml0, /model_catalog_json = "C:\/h\/o\\"k\/c\.json"/, 'quotes are escaped');
  assert.match(toml0, /base_url = "http:\/\/s:20100\/v1"\n/, 'a trailing slash or /v1 is not doubled');
  assert.match(toml0, /model_context_window = 200000\nmodel_auto_compact_token_limit = 160000/);
  assert.match(toml0, /env_key = "SHAREAI_API_KEY"[\s\S]*capabilities\.remote_compaction = "unsupported"/);

  const home = mkdtempSync(path.join(work, 'codexhome-'));
  writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(cache));
  const r = await run(['codex-setup', 'claude-opus-5-5', '--context', '300000'], {env:{CODEX_HOME:home, SHAREAI_URL:'http://10.0.0.5:20100'}});
  assert.equal(r.code, 0, r.out);
  const toml = readFileSync(path.join(home, 'shareai-claude.config.toml'), 'utf8');
  assert.match(toml, /^model = "claude-opus-5-5"/);
  assert.match(toml, /base_url = "http:\/\/10\.0\.0\.5:20100\/v1"/);
  assert.match(r.out, /copied from gpt-x, Codex 0\.167\.2 cache/);
  assert.match(r.out, /warning: the ShareAI key travels unencrypted/);
  assert.equal(JSON.parse(readFileSync(path.join(home, 'shareai-claude-models.json'), 'utf8')).models[0].context_window, 300000);
  assert.equal((await run(['codex-setup', 'claude-opus-5-5'], {env:{CODEX_HOME:home}})).code, 1, 'existing files are kept without --force');
  assert.equal((await run(['codex-setup', 'claude-opus-5-5', '--force'], {env:{CODEX_HOME:home}})).code, 0);
  const missing = await run(['codex-setup', 'claude-opus-5-5'], {env:{CODEX_HOME:mkdtempSync(path.join(work, 'empty-'))}});
  assert.match(missing.out, /models_cache\.json/);
});

