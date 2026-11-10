// Shared test fixture: provision a test-owned, fresh SQLite file the way an
// operator-attested pristine install would, so the production client (which
// opens with fileMustExist and never creates or silently repairs a database)
// can initialize it. Call after the test has set DATABASE_URL and the other
// synthetic environment values, and before the first getDb()/initDatabase().
import Database from 'better-sqlite3';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function provisionFreshDatabase(file) {
  if (typeof file !== 'string' || !file || file === ':memory:') throw new Error('provisionFreshDatabase requires a test-owned file path');
  if (existsSync(file)) throw new Error('provisionFreshDatabase refuses an existing file');
  const {provisionFreshSafetySchema} = await import('../../src/db/client.ts');
  const raw = new Database(file);
  try { raw.transaction(() => provisionFreshSafetySchema(raw)).immediate(); }
  finally { raw.close(); }
}

// Convenience for the common pattern `DATABASE_URL=sqlite:<file>`.
export async function provisionFromEnv() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('sqlite:')) throw new Error('DATABASE_URL must be sqlite:<file>');
  await provisionFreshDatabase(url.slice('sqlite:'.length));
}

// Replacement for DATABASE_URL=sqlite::memory: (which the production client
// refuses: an empty database lacks the attested safety schema). Points
// DATABASE_URL at a provisioned file in a private temp directory, removed on exit.
export async function useFreshFileDatabase() {
  const base = process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : os.tmpdir();
  const dir = mkdtempSync(path.join(base, 'fresh-db-'));
  process.on('exit', () => { try { rmSync(dir, {recursive:true, force:true}); } catch { /* open handle on Windows; scratch is pruned */ } });
  const file = path.join(dir, 'db.sqlite');
  process.env.DATABASE_URL = `sqlite:${file}`;
  await provisionFreshDatabase(file);
  return file;
}
