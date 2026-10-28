import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

test('closed database cannot be lazily reopened by delayed work', () => {
  const loader = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
  const entry = pathToFileURL(path.resolve('src/db/client.ts')).href;
  const script = `import assert from 'node:assert/strict'; import {getDb,closeDatabase} from ${JSON.stringify(entry)}; getDb(); closeDatabase(); assert.throws(() => getDb(), /closed|shut/i);`;
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], { cwd: process.env.TMPDIR || os.tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' } });
  assert.equal(result.status, 0, result.stderr);
});
