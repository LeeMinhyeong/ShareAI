import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// ADR 0018: only `npm run db:init` creates a database; server start and db:migrate never do.
const scratch = () => mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'router-phase1-'));
const env = url => ({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url, ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false', LOG_LEVEL: 'error' });
const npm = (script, url) => spawnSync(`npm run ${script}`, { shell: true, cwd: path.resolve('.'), encoding: 'utf8', env: env(url), timeout: 60000 });
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('db:init creates a new database in a new directory that db:migrate then accepts', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'nested', 'router.sqlite');
    const init = npm('db:init', `sqlite:${file}`);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.match(init.stdout, /Initialized new database/);
    assert.ok(existsSync(file));
    const migrate = npm('db:migrate', `sqlite:${file}`);
    assert.equal(migrate.status, 0, migrate.stdout + migrate.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('db:migrate never creates a missing database', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'missing.sqlite');
    const result = npm('db:migrate', `sqlite:${file}`);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('db:init refuses an existing path, even an empty file, and leaves it untouched', () => {
  const dir = scratch();
  try {
    const empty = path.join(dir, 'empty.sqlite');
    writeFileSync(empty, '');
    const first = npm('db:init', `sqlite:${empty}`);
    assert.notEqual(first.status, 0);
    assert.match(first.stdout + first.stderr, /already exists/);
    assert.equal(statSync(empty).size, 0);

    const file = path.join(dir, 'initialized.sqlite');
    assert.equal(npm('db:init', `sqlite:${file}`).status, 0);
    const before = digest(file);
    const second = npm('db:init', `sqlite:${file}`);
    assert.notEqual(second.status, 0);
    assert.match(second.stdout + second.stderr, /already exists/);
    assert.equal(digest(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('in-memory SQLite is rejected by db:init and db:migrate with a clear message', () => {
  for (const script of ['db:init', 'db:migrate']) {
    const result = npm(script, 'sqlite::memory:');
    assert.notEqual(result.status, 0, script);
    assert.match(result.stdout + result.stderr, /In-memory SQLite and file: URIs are not supported/, script);
  }
});

test('db:init refuses leftover SQLite sidecar files and file: URIs without creating a database', () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'router.sqlite');
    writeFileSync(file + '-wal', 'synthetic leftover');
    const leftover = npm('db:init', `sqlite:${file}`);
    assert.notEqual(leftover.status, 0);
    assert.match(leftover.stdout + leftover.stderr, /-wal already exists/);
    assert.equal(existsSync(file), false);
    const uri = npm('db:init', `sqlite:file:${file}`);
    assert.notEqual(uri.status, 0);
    assert.match(uri.stdout + uri.stderr, /file: URIs are not supported/);
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two simultaneous db:init runs create the database exactly once', async () => {
  const dir = scratch();
  try {
    const file = path.join(dir, 'race.sqlite');
    const start = () => { const child = spawn(`npm run db:init`, { shell: true, cwd: path.resolve('.'), env: env(`sqlite:${file}`), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
      return once(child, 'close').then(([code]) => ({ code, out })); };
    const results = await Promise.all([start(), start()]);
    assert.equal(results.filter(r => r.code === 0).length, 1, JSON.stringify(results));
    assert.match(results.find(r => r.code !== 0).out, /already exists/);
    assert.equal(npm('db:migrate', `sqlite:${file}`).status, 0, 'the winner left a valid database');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
