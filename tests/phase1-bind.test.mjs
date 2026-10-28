import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';

test('bind failure leaves existing SQLite database byte-for-byte unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'router-bind-'));
  const dbPath = path.join(dir, 'existing.sqlite');
  const db = new Database(dbPath); db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'untouched\')'); db.close();
  const before = fs.readFileSync(dbPath);
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  try {
    const port = listener.address().port;
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('src/server.ts')], { cwd: dir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: `sqlite:${dbPath}`, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false' }, stdio: 'ignore' });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.deepEqual(fs.readFileSync(dbPath), before);
    assert.deepEqual(fs.readdirSync(dir), ['existing.sqlite']);
  } finally { await new Promise(resolve => listener.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
