import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const entry = pathToFileURL(path.resolve('src/config/env.ts')).href;
function load(overrides = {}) {
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), ...overrides };
  for (const key of ['PORT', 'LOG_PRETTY']) if (overrides[key] === undefined) delete env[key];
  return spawnSync(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', `import { env } from ${JSON.stringify(entry)}; console.log(JSON.stringify(env));`], { cwd: process.env.TMPDIR || os.tmpdir(), env, encoding: 'utf8' });
}
test('PORT rejects values outside TCP port range and fractions', () => {
  for (const PORT of ['0', '-1', '65536', '1.5']) assert.notEqual(load({ PORT }).status, 0, PORT);
  for (const PORT of ['1', '65535']) assert.equal(load({ PORT }).status, 0, PORT);
});
test('default PORT is 20100', () => {
  const result = load();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).PORT, 20100);
});
test('encryption key rejects non-hex characters', () => {
  assert.notEqual(load({ ENCRYPTION_KEY: 'z'.repeat(64) }).status, 0);
  assert.equal(load({ ENCRYPTION_KEY: 'A1'.repeat(32) }).status, 0);
});
test('rejects invalid SQLite URLs and the public example administrator key', () => {
  for (const DATABASE_URL of ['', 'postgres://localhost/db', 'sqlite:', 'sqlite:   ', 'sqlite://host/db']) assert.notEqual(load({ DATABASE_URL }).status, 0, DATABASE_URL);
  assert.equal(load({ DATABASE_URL: 'sqlite:./data/example.db' }).status, 0);
  assert.equal(load({ DATABASE_URL: 'sqlite::memory:' }).status, 0);
});
test('rejects the public example administrator key', () => {
  assert.notEqual(load({ ADMIN_API_KEY: 'admin_your_secure_key_here' }).status, 0);
});

test('LOG_PRETTY parses false as false', () => {
  const result = load({ LOG_PRETTY: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).LOG_PRETTY, false);
  const enabled = load({ LOG_PRETTY: 'true' });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).LOG_PRETTY, true);
  assert.notEqual(load({ LOG_PRETTY: 'not-a-boolean' }).status, 0);
});
