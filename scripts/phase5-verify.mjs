#!/usr/bin/env node
// Phase 5 real-client verification helper (ADR 0019 completion item 6).
// Talks only to the local ShareAI admin API. It never prints provider credentials;
// the only secret it prints is a newly created ShareAI *user* key (shown once).
//
//   SHAREAI_URL   default http://127.0.0.1:20100
//   ADMIN_API_KEY required (same value as the server's .env)
//
// Commands:
//   status                                  accounts, routing state, today's usage
//   user <name>                             create a ShareAI user and print its key once
//   login <anthropic|openai> <name>         browser OAuth login for a subscription account
//   import <anthropic|openai> <name> <file> import a credential from a file (API key, setup-token,
//                                           ~/.claude/.credentials.json or ~/.codex/auth.json)
//   import-env <anthropic|openai> <name> <ENV_VAR>   import an API key from an environment variable
//   only <accountId>                        make this the only active account of its provider
//   enable <accountId> | disable <accountId>
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const BASE = (process.env.SHAREAI_URL || 'http://127.0.0.1:20100').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_API_KEY;
const [cmd, ...args] = process.argv.slice(2);

class Fatal extends Error {}
// Throws instead of process.exit(): exiting with fetches/readline in flight crashes Node on Windows.
function die(message) { throw new Fatal(message); }
async function api(method, path, body) {
  if (!ADMIN) die('ADMIN_API_KEY is not set');
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
  console.log('\naccounts (routing state: no_known_block = selectable, open = attempt in flight or uncertain, restricted = temporary block):');
  for (const a of accounts) console.log(`  ${a.id}  ${a.provider.padEnd(9)} ${a.credentialType.padEnd(7)} ${String(a.status).padEnd(14)} ${(state.get(a.id) ?? '-').padEnd(15)} ${a.name}${a.status === 'error' && a.lastError ? `\n      ${a.lastError}` : ''}`);
  if (!accounts.length) console.log('  (none)');
  console.log(`\ntoday usage: ${JSON.stringify(stats.todayUsage)}`);
}

async function user(name) {
  if (!name) die('usage: user <name>');
  const r = await api('POST', '/admin/users', { name, email: `${name}@phase5.invalid`, tier: 'pro', dailyLimit: 1000 });
  console.log(`user ${r.user.id} created. ShareAI user key (shown once, use it as ANTHROPIC_AUTH_TOKEN / SHAREAI_API_KEY):\n${r.apiKey}`);
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
  case 'user': await user(args[0]); break;
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
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 18).map(l => l.slice(3)).join('\n'));
}
} catch (error) {
  if (!(error instanceof Fatal)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
