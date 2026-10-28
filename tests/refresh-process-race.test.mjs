import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
const scratch = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, 'refresh-race-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `sqlite:${path.join(dir, 'test.db')}`, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { closeDatabase } = await import('../src/db/client.ts');
const repo = new AccountRepository();
test('two racing processes cannot submit the same token twice', { timeout: 15000 }, async () => {
  const a = repo.create({ name: 'race', provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify({kind:'oauth', accessToken:'old', refreshToken:'old-refresh', expiresAt:1}) });
  const children = [0, 1].map(() => fork(new URL('./refresh-race-child.mjs', import.meta.url), [], { env: {...process.env, TEST_ACCOUNT_ID: a.id}, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  try {
    const first = await Promise.all(children.map(c => once(c, 'message').then(([m]) => m)));
    assert.deepEqual([...first].sort(), ['failure', 'fetch']);
    const owner = children[first.indexOf('fetch')];
    const result = once(owner, 'message');
    owner.send('success');
    assert.equal((await result)[0], 'success');
    const current = repo.findById(a.id);
    assert.equal(JSON.parse(current.credentials).refreshToken, 'next');
    assert.equal(current.status, 'active');
  } finally {
    for (const c of children) if (c.connected) c.disconnect();
  }
});
process.on('exit', () => { closeDatabase(); rmSync(dir, {recursive:true, force:true}); });
