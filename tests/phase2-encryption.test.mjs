import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// dotenv must not load any project or user environment files.
const originalCwd = process.cwd();
const isolatedCwd = mkdtempSync(path.join(tmpdir(), 'credential-vault-test-'));
process.chdir(isolatedCwd);
after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(isolatedCwd, { recursive: true, force: true });
  } catch (error) {
    // Windows loader workers can hold the current directory until process exit.
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
  }
});

// Synthetic fixtures only. No database, account, or network access.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '01'.repeat(32);
process.env.ADMIN_API_KEY = 'test-admin-fixture-12345';
const { CredentialVault } = await import('../src/utils/encryption.ts');
const { env } = await import('../src/config/env.ts');

function vaultWithKey(key) {
  const original = env.ENCRYPTION_KEY;
  try {
    env.ENCRYPTION_KEY = key;
    return new CredentialVault();
  } finally {
    env.ENCRYPTION_KEY = original;
  }
}
function flip(hex) {
  return (hex[0] === '0' ? '1' : '0') + hex.slice(1);
}

test('round-trips empty, Unicode and long synthetic values', () => {
  const vault = new CredentialVault();
  for (const value of ['', '한글 🔐\u0000 sample', 'x'.repeat(10000)]) {
    assert.ok(vault.decrypt(vault.encrypt(value)) === value);
  }
});

test('independent encryption uses distinct IVs', () => {
  const vault = new CredentialVault();
  const first = vault.encrypt('fixture');
  const second = vault.encrypt('fixture');
  assert.ok(first.split(':')[0] !== second.split(':')[0]);
});

test('rejects changes to IV, tag or ciphertext', () => {
  const vault = new CredentialVault();
  const parts = vault.encrypt('fixture').split(':');
  for (let i = 0; i < parts.length; i++) {
    const altered = [...parts];
    altered[i] = flip(altered[i]);
    assert.throws(() => vault.decrypt(altered.join(':')));
  }
});

test('rejects ciphertext encrypted under another key', () => {
  const ciphertext = new CredentialVault().encrypt('fixture');
  const other = vaultWithKey('02'.repeat(32));
  assert.throws(() => other.decrypt(ciphertext));
});

test('rejects invalid suffix on IV', () => {
  const vault = new CredentialVault();
  const parts = vault.encrypt('fixture').split(':');
  parts[0] += 'zz';
  assert.throws(() => vault.decrypt(parts.join(':')));
});

test('rejects truncated authentication tag', () => {
  const vault = new CredentialVault();
  const parts = vault.encrypt('fixture').split(':');
  parts[1] = parts[1].slice(0, 24);
  assert.throws(() => vault.decrypt(parts.join(':')));
});

test('rejects malformed ciphertext structure and hex fields', () => {
  const vault = new CredentialVault();
  const parts = vault.encrypt('fixture').split(':');
  for (const value of ['', 'a:b', 'a:b:c:d', `${parts[0]}:${parts[1]}:a`, `${parts[0]}:zz${parts[1]}:${parts[2]}`]) {
    assert.throws(() => vault.decrypt(value));
  }
});

test('configuration rejects missing, short and non-hex keys', () => {
  const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;
  const entry = new URL('../src/utils/encryption.ts', import.meta.url).href;
  for (const key of [undefined, '', 'a'.repeat(62), 'z'.repeat(64), 'a'.repeat(64)]) {
    const isolatedEnv = { SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ADMIN_API_KEY: 'test-admin-fixture-12345' };
    if (key !== undefined) isolatedEnv.ENCRYPTION_KEY = key;
    const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', `import ${JSON.stringify(entry)}`], { cwd: process.cwd(), env: isolatedEnv, encoding: 'utf8' });
    if (key === 'a'.repeat(64)) {
      assert.ok(result.status === 0);
    } else {
      assert.ok(result.status !== null && result.status !== 0 && result.stderr.includes('ENCRYPTION_KEY'));
    }
  }
});

test('rejects malformed hexadecimal ciphertext instead of silently ignoring suffixes', () => {
  const vault = new CredentialVault();
  const ciphertext = vault.encrypt('fixture');
  assert.throws(() => vault.decrypt(`${ciphertext}zz`));
});
