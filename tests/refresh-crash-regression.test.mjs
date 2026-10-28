import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const scratch = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, 'refresh-crash-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `sqlite:${path.join(dir, 'test.db')}`, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { closeDatabase } = await import('../src/db/client.ts');
const repo = new AccountRepository();
function child(id) {
  const process = fork(new URL('./refresh-race-child.mjs', import.meta.url), [], { env: {...globalThis.process.env, TEST_ACCOUNT_ID: id}, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const messages = [];
  process.on('message', m => messages.push(m));
  const exit = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code, signal) => resolve({code, signal}));
  });
  return { process, messages, exit };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(25); } throw new Error('Timed out waiting for child'); }

test('crashed exchanger must not permit replay of a possibly consumed token', {timeout:10000}, async () => {
  const credentials = JSON.stringify({kind:'oauth', accessToken:'old', refreshToken:'old-refresh', expiresAt:1});
  const account = repo.create({name:'crash', provider:'openai', credentialType:'oauth', credentials});
  const children = [child(account.id)];
  try {
    await waitFor(() => children[0].messages.includes('fetch'));
    children[0].process.kill(); await children[0].exit;
    children.push(child(account.id));
    const exit = await Promise.race([children[1].exit, delay(5000).then(() => { throw new Error('replacement child did not exit'); })]);
    assert.deepEqual(exit, {code:0, signal:null}, 'replacement child failed unexpectedly');
    assert.ok(children[1].messages.includes('failure'), 'replacement child did not report rejection');
    assert.ok(!children[1].messages.includes('fetch'), 'crash allowed token replay despite unknown provider outcome');
    assert.equal(repo.findById(account.id).credentials, credentials);
  } finally { for (const c of children) { if (c.process.exitCode === null && c.process.signalCode === null) c.process.kill(); await c.exit; } }
});
test('disable during successful exchange persists rotation but does not return usable auth', {timeout:10000}, async () => {
  const credentials = JSON.stringify({kind:'oauth', accessToken:'old', refreshToken:'old-refresh-2', expiresAt:1});
  const account = repo.create({name:'disable-success', provider:'openai', credentialType:'oauth', credentials});
  const c = child(account.id);
  try {
    await waitFor(() => c.messages.includes('fetch'));
    repo.update(account.id, {status:'disabled', lastError:'administrator'});
    c.process.send('success');
    const exit = await Promise.race([c.exit, delay(5000).then(() => { throw new Error('exchange child did not exit'); })]);
    assert.deepEqual(exit, {code:0, signal:null});
    const saved = repo.findById(account.id);
    assert.equal(saved.status, 'disabled');
    assert.equal(saved.lastError, 'administrator');
    assert.equal(JSON.parse(saved.credentials).refreshToken, 'next');
    assert.ok(c.messages.includes('failure'), 'disabled account returned usable credentials');
  } finally { if (c.process.exitCode === null && c.process.signalCode === null) c.process.kill(); await c.exit; }
});
process.on('exit', () => { closeDatabase(); rmSync(dir, {recursive:true, force:true}); });
