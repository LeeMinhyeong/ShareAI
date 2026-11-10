import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

test('closed database cannot be lazily reopened by delayed work', () => {
  const loader = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
  const entry = pathToFileURL(path.resolve('src/db/client.ts')).href;
  // The production client never creates a database: the child provisions its own fresh file first.
  const helper = pathToFileURL(path.resolve('tests/helpers/fresh-db.mjs')).href;
  const dbDir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'db-close-'));
  const dbFile = path.join(dbDir, 'db.sqlite');
  const script = `import assert from 'node:assert/strict'; await (await import(${JSON.stringify(helper)})).provisionFromEnv(); const {getDb,closeDatabase} = await import(${JSON.stringify(entry)}); getDb(); closeDatabase(); assert.throws(() => getDb(), /closed|shut/i);`;
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], { cwd: process.env.TMPDIR || os.tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: `sqlite:${dbFile}`, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' } });
  rmSync(dbDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
});
