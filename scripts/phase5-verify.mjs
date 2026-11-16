#!/usr/bin/env node
// Phase 5 real-client verification helper (ADR 0019 completion item 6).
// Talks only to the local ShareAI admin API. It never prints provider credentials;
// the only secret it prints is a newly created ShareAI *user* key (shown once).
//
//   SHAREAI_URL   default http://127.0.0.1:20100
//   ADMIN_API_KEY default: read from ./.env (run from the project folder)
//   SHAREAI_API_KEY probes only; default: the key saved by `user <name> --save`
//
// Commands:
//   status                                  accounts, routing state, today's usage
//   user <name> [--save]                    create a ShareAI user; prints its key once, or with --save
//                                           writes it to data/verify-user.key without printing it
//   login <anthropic|openai> <name>         browser OAuth login for a subscription account
//   import <anthropic|openai> <name> <file> import a credential from a file (API key, setup-token,
//                                           ~/.claude/.credentials.json or ~/.codex/auth.json)
//   import-env <anthropic|openai> <name> <ENV_VAR>   import an API key from an environment variable
//   only <accountId>                        make this the only active account of its provider
//   enable <accountId> | disable <accountId>
//   concurrency <accountId> <1-16>          requests the account may have in flight at once (ADR 0021)
//   probe empty                             no account yet: what clients see (403)
//   probe claude <model...>                 Codex-shaped requests with Claude models (ADR 0023)
//   probe gpt <model...>                    Claude Code-shaped requests with OpenAI models (ADR 0022)
//   probe parallel <model> [n]              n requests at once on the active accounts (ADR 0021)
//                                           probe results are redacted and saved under data/
//   codex-setup <claude-model...> [--context N] [--base <slug>] [--force]
//                                           writes the Codex profile shareai-claude (catalog + config)
//                                           into CODEX_HOME (default ~/.codex) for Claude models (ADR 0023)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createProber, buildClaudeCatalog, claudeProfileToml } from './verify-probes.mjs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const BASE = (process.env.SHAREAI_URL || 'http://127.0.0.1:20100').replace(/\/+$/, '');
// The admin key is read from .env instead of being typed: chat tools may mask it when shown.
function dotenvValue(name) {
  try {
    const line = readFileSync('.env', 'utf8').split(/\r?\n/).find(l => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : undefined;
  } catch { return undefined; }
}
const ADMIN = process.env.ADMIN_API_KEY || dotenvValue('ADMIN_API_KEY');
const USER_KEY_FILE = 'data/verify-user.key';
const [cmd, ...args] = process.argv.slice(2);

class Fatal extends Error {}
// Throws instead of process.exit(): exiting with fetches/readline in flight crashes Node on Windows.
function die(message) { throw new Fatal(message); }
async function api(method, path, body) {
  if (!ADMIN) die('ADMIN_API_KEY is not set and ./.env has none (run from the project folder)');
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { die(`cannot reach ${BASE} (is the server running?)`); }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) die(`${method} ${path} -> ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
  return json;
}
const accountsOf = async () => (await api('GET', '/admin/accounts')).accounts ?? [];
const provider = value => (value === 'anthropic' || value === 'openai') ? value : die('provider must be anthropic or openai');

async function status() {
  const health = await fetch(BASE + '/health').then(r => r.ok, () => false);
  console.log(`server ${BASE}: ${health ? 'up' : 'DOWN'}`);
  const [accounts, snapshot, stats] = [await accountsOf(), await api('GET', '/admin/routing-snapshot'), await api('GET', '/admin/stats')];
  const state = new Map((snapshot.accounts ?? snapshot.rows ?? []).filter(r => r.kind === 'upstream').map(r => [r.id, r.state]));
  console.log('\naccounts (routing state: no_known_block = selectable, open = every slot in flight or uncertain, restricted = temporary block; xN = concurrency limit):');
  for (const a of accounts) console.log(`  ${a.id}  ${a.provider.padEnd(9)} ${a.credentialType.padEnd(7)} ${String(a.status).padEnd(14)} ${(state.get(a.id) ?? '-').padEnd(15)} x${String(a.maxConcurrency ?? 1).padEnd(3)} ${a.name}${a.status === 'error' && a.lastError ? `\n      ${a.lastError}` : ''}`);
  if (!accounts.length) console.log('  (none)');
  console.log(`\ntoday usage: ${JSON.stringify(stats.todayUsage)}`);
}

async function user(name, save) {
  if (!name || name.startsWith('--')) die('usage: user <name> [--save]');
  if (save && existsSync(USER_KEY_FILE)) die(`${USER_KEY_FILE} already exists; delete it first to save a new key`);
  const r = await api('POST', '/admin/users', { name, email: `${name}@phase5.invalid`, tier: 'pro', dailyLimit: 1000 });
  if (save) {
    mkdirSync('data', { recursive: true });
    // 'wx' never replaces an existing key file. On Windows the mode is ignored; the folder's ACL protects it.
    writeFileSync(USER_KEY_FILE, r.apiKey + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`user ${r.user.id} created. Its ShareAI key is in ${USER_KEY_FILE} (not printed).`);
  } else console.log(`user ${r.user.id} created. ShareAI user key (shown once, use it as ANTHROPIC_AUTH_TOKEN / SHAREAI_API_KEY):\n${r.apiKey}`);
}

function codexSetup(argv) {
  const opt = name => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v ?? die(`${name} needs a value`); };
  const force = argv.includes('--force'); if (force) argv.splice(argv.indexOf('--force'), 1);
  const context = opt('--context'), base = opt('--base');
  const models = argv;
  if (!models.length) die('usage: codex-setup <claude-model...> [--context N] [--base <slug>] [--force]');
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  let cache; try { cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')); } catch { die(`cannot read ${join(home, 'models_cache.json')}; run codex once while signed in`); }
  let built; try { built = buildClaudeCatalog(cache, models, { context: context === undefined ? undefined : Number(context), base }); } catch (e) { die(e.message); }
  const catalogPath = join(home, 'shareai-claude-models.json'), profilePath = join(home, 'shareai-claude.config.toml');
  for (const p of [catalogPath, profilePath]) if (existsSync(p) && !force) die(`${p} exists; pass --force to replace it`);
  writeFileSync(catalogPath, JSON.stringify(built.catalog, null, 2));
  writeFileSync(profilePath, claudeProfileToml({ model: models[0], catalogPath, baseUrl: BASE, context: built.context }));
  const version = typeof cache.client_version === 'string' ? cache.client_version : 'unknown';
  console.log(`wrote ${profilePath}\nwrote ${catalogPath} (${models.join(', ')}; copied from ${built.base}, Codex ${version} cache)\nShareAI URL in the profile: ${BASE}/v1 (set SHAREAI_URL before this command for another host)\nstart Codex with: codex --profile shareai-claude   (switch models with /model)\nrerun with --force after upgrading Codex`);
  if (/^http:\/\//i.test(BASE) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(BASE)) console.log('warning: the ShareAI key travels unencrypted over plain http to a non-local host');
}

async function probe(kind, rest) {
  let key = process.env.SHAREAI_API_KEY;
  if (!key) { try { key = readFileSync(USER_KEY_FILE, 'utf8').trim(); } catch { key = ''; } }
  if (!key) die(`no ShareAI user key: set SHAREAI_API_KEY or run "user <name> --save" first`);
  // Results describe the accounts active right now; show them so a missing `only` is noticed.
  if (ADMIN) {
    try {
      const active = (await accountsOf()).filter(a => a.status === 'active');
      console.log(`active accounts: ${active.length ? active.map(a => `${a.name} (${a.provider} ${a.credentialType}, x${a.maxConcurrency ?? 1})`).join(', ') : 'none'}\n`);
    } catch { /* the probe itself reports an unreachable server */ }
  }
  const p = createProber({ base: BASE, key });
  try {
    if (kind === 'claude') await p.claude(rest);
    else if (kind === 'gpt') await p.gpt(rest);
    else if (kind === 'parallel') await p.parallel(rest[0], rest[1] === undefined ? 2 : Number(rest[1]));
    else if (kind === 'empty') await p.empty();
    else die('usage: probe <empty|claude|gpt|parallel> ...');
  } catch (error) {
    if (error instanceof Fatal) throw error;
    die(error.message);
  }
  if (p.results.length) {
    p.save('data', kind);
    if (p.results.some(r => r.verdict === 'FAIL')) process.exitCode = 1;
  }
}

async function login(p, name) {
  if (!name) die('usage: login <anthropic|openai> <name>');
  const start = await api('POST', '/admin/accounts/oauth/start', { name, provider: provider(p) });
  console.log(`Open this URL in a browser and sign in with the ${p === 'anthropic' ? 'Claude' : 'ChatGPT'} account:\n\n${start.authUrl}\n`);
  if (p === 'openai' && start.callbackListening) {
    console.log('Waiting for the automatic callback on http://localhost:1455 (or paste the final localhost URL below).');
  } else if (p === 'openai') {
    console.log('Automatic callback is unavailable (port 1455 busy?). After signing in, paste the full http://localhost:1455/auth/callback?... URL.');
  } else {
    console.log('After signing in, Claude shows a code (code#state). Paste it below.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let stopped = false;
  const poll = (async () => {
    for (let i = 0; i < 600 && !stopped; i++) {
      const flow = await api('GET', `/admin/accounts/oauth/${start.flowId}`).catch(e => { if (stopped) return { status: 'pending' }; throw e; });
      if (flow.status === 'done' || flow.status === 'error') return flow;
      await new Promise(r => setTimeout(r, 1000));
    }
    return { status: 'timeout' };
  })();
  const pasted = (async () => {
    const code = (await rl.question('code / callback URL (Enter to keep waiting): ')).trim();
    if (!code) return null;
    return api('POST', `/admin/accounts/oauth/${start.flowId}/finish`, { code }).then(() => api('GET', `/admin/accounts/oauth/${start.flowId}`));
  })();
  let flow;
  try { flow = await Promise.race([poll, pasted.then(f => f ?? poll)]); }
  finally { stopped = true; rl.close(); }
  console.log(`login ${flow.status}${flow.accountId ? `, account ${flow.accountId}` : ''}${flow.error ? `: ${flow.error}` : ''}`);
  if (!(flow.status === 'done' || flow.accountId)) process.exitCode = 1;
}

async function importCredential(p, name, credentials) {
  const r = await api('POST', '/admin/accounts/import', { name, provider: provider(p), credentials });
  console.log(`account ${r.account.id} imported (${r.account.provider}, ${r.account.credentialType}, ${r.account.status})`);
}

async function only(id) {
  const accounts = await accountsOf();
  const target = accounts.find(a => a.id === id) ?? die(`account ${id} not found`);
  for (const a of accounts) {
    if (a.provider !== target.provider) continue;
    const next = a.id === id ? 'active' : 'disabled';
    if (a.status !== next) await api('PATCH', `/admin/accounts/${a.id}`, { status: next });
  }
  console.log(`${target.name} is now the only active ${target.provider} account.`);
}

try {
switch (cmd) {
  case 'status': await status(); break;
  case 'user': await user(args[0], args.includes('--save')); break;
  case 'probe': await probe(args[0], args.slice(1)); break;
  case 'codex-setup': codexSetup(args); break;
  case 'login': await login(args[0], args[1]); break;
  case 'import': {
    if (args.length < 3) die('usage: import <anthropic|openai> <name> <file>');
    let text; try { text = readFileSync(args[2], 'utf8'); } catch { die(`cannot read ${args[2]}`); }
    await importCredential(args[0], args[1], text.trim()); break;
  }
  case 'import-env': {
    if (args.length < 3) die('usage: import-env <anthropic|openai> <name> <ENV_VAR>');
    const value = process.env[args[2]] ?? die(`${args[2]} is not set`);
    await importCredential(args[0], args[1], value.trim()); break;
  }
  case 'only': await only(args[0] ?? die('usage: only <accountId>')); break;
  case 'enable': case 'disable':
    await api('PATCH', `/admin/accounts/${args[0] ?? die(`usage: ${cmd} <accountId>`)}`, { status: cmd === 'enable' ? 'active' : 'disabled' });
    console.log(`${args[0]} ${cmd}d`); break;
  case 'concurrency': {
    const n = Number(args[1]);
    if (!args[0] || !Number.isInteger(n) || n < 1 || n > 16) die('usage: concurrency <accountId> <1-16>');
    await api('PATCH', `/admin/accounts/${args[0]}`, { maxConcurrency: n });
    console.log(`${args[0]} may now run ${n} request(s) at once`); break;
  }
  default:
    { const src = readFileSync(new URL(import.meta.url), 'utf8').split('\n'); console.log(src.slice(1, src.findIndex(l => l.startsWith('import '))).map(l => l.slice(3)).join('\n')); }
}
} catch (error) {
  if (!(error instanceof Fatal)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
