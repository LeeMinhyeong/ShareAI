import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('db:migrate initializes an isolated SQLite file', () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'router-phase1-'));
  try {
    const file = path.join(dir, 'router.sqlite');
    const result = spawnSync('npm run db:migrate', { shell: true, cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: `sqlite:${file}`, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
