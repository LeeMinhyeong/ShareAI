import express from 'express';
import Database from 'better-sqlite3';
import {spawnSync} from 'node:child_process';
import {once} from 'node:events';

const [file, port, mode, restriction] = process.argv.slice(2);
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'info', LOG_PRETTY:'false', PORT:'1', HOST:'127.0.0.1'});
// Only the two known production endpoints can be redirected; never use the network otherwise.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const target = String(url);
  if (target === 'https://auth.openai.com/api/accounts/oauth/token') return nativeFetch(`http://127.0.0.1:${port}/refresh`, options);
  if (target === 'https://api.openai.com/v1/responses') return nativeFetch(`http://127.0.0.1:${port}/inference`, options);
  throw new Error(`Unexpected outbound endpoint: ${target}`);
};
const {accountPool} = await import('../src/account-pool/manager.ts');
const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
const {CredentialVault} = await import('../src/utils/encryption.ts');
const {closeDatabase} = await import('../src/db/client.ts');
const select = accountPool.selectCandidate.bind(accountPool);
let selected = false, barrier = false;
const selections = [];
accountPool.selectCandidate = async (...args) => {
  const result = await select(...args);
  if (!selected) {
    if (result?.kind !== 'siwc' || result.id !== 'a') throw new Error('fixture did not select A');
    selected = true;
  }
  if (result?.kind === 'siwc') selections.push(result.id);
  return result;
};
const exec = Database.prototype.exec;
Database.prototype.exec = function(sql) {
  if (sql === 'BEGIN IMMEDIATE' && selected && !barrier) {
    // Verify this is the intended post-refresh/pre-admission boundary, not merely a fetch barrier.
    const check = new Database(file, {readonly:true});
    try {
      const snapshot = new SiwcStore(check, new CredentialVault(), {initialize:false}).readSnapshot('a');
      // The router's pre-refresh v2/access gate is also a writer transaction; the barrier belongs
      // to the admission after the refresh, so let the gate (still holding the expired token) pass.
      if (mode === 'refresh' && snapshot.credential.accessToken === 'expired-access') return exec.call(this, sql);
      barrier = true;
      if (snapshot.credential.accessToken !== (mode === 'refresh' ? 'rotated-access' : 'valid-access')) throw new Error('wrong snapshot at admission barrier');
      if (check.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get()) throw new Error('A already OPEN at barrier');
      if (mode === 'refresh' && check.prepare('SELECT COUNT(*) n FROM siwc_resolved_refresh_intents WHERE result_revision=?').get(snapshot.revision).n !== 1) throw new Error('refresh not durably completed');
    } finally { check.close(); }
    // The competitor commits an OPEN, or a v2 restriction through the real store (ADR 0008), in its own process.
    const store = new URL('../src/db/account-429-v2-store.ts', import.meta.url).href;
    const script = `import {createRequire} from 'node:module';import {arm429V2} from ${JSON.stringify(store)};const D=createRequire(${JSON.stringify(import.meta.url)})('better-sqlite3');const d=new D(process.argv[1]);d.exec('BEGIN IMMEDIATE');if(process.argv[2]==='open')d.prepare("INSERT INTO siwc_account_attempts(account_id,attempt_id) VALUES('a','competitor')").run();else arm429V2(d,'siwc','a',60000);d.exec('COMMIT');d.close();`;
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script, file, restriction], {cwd:new URL('..', import.meta.url), encoding:'utf8', timeout:8000});
    if (child.status !== 0) throw new Error(`competitor failed: ${child.stderr} ${child.error ?? ''}`);
    process.send?.({event:'committed', pid:child.pid, restriction});
  }
  return exec.call(this, sql);
};
// Import the real entrypoint unchanged; redirect only its listen port to an
// ephemeral loopback port while retaining all production middleware and startup.
const originalListen = express.application.listen;
let server;
let started;
const startup = new Promise(resolve => { started = resolve; });
express.application.listen = function(_port, _host, callback) {
  server = originalListen.call(this, 0, '127.0.0.1', () => { callback(); started(); });
  return server;
};
try { await import('../src/server.ts'); } finally { express.application.listen = originalListen; }
if (!server) throw new Error('production server did not listen');
await Promise.race([startup, once(server,'error').then(([error]) => { throw error; })]);
if (!server.listening || process.exitCode) throw new Error('production startup failed');
if (server.address().port === 20128) throw new Error('reserved port');
process.send?.({event:'ready', port:server.address().port, pid:process.pid});
process.on('message', message => {
  if (message === 'selections') process.send?.({event:'selections', selections});
  if (message === 'stop') server.close(() => {closeDatabase(); process.exit(0);});
});
