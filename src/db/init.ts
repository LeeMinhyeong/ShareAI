// Explicit fresh-install command (ADR 0018): `npm run db:init`.
//
// Server start and `db:migrate` never create a database (a missing file cannot prove a fresh
// install, and a mistyped path or missing mount must not silently become an empty database).
// This command is the only production path that creates one, and only when nothing exists at
// the target path: it creates the file exclusively, provisions the attested safety schema in
// one IMMEDIATE transaction, then runs the normal initializer to build and validate the rest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** Creates and provisions a brand-new database file. Refuses any existing path, even an empty file. */
export async function createFreshDatabase(dbPath: string): Promise<string> {
  const { isInMemoryPath, IN_MEMORY_UNSUPPORTED, provisionFreshSafetySchema } = await import('./client.js');
  if (!dbPath || isInMemoryPath(dbPath)) throw new Error(IN_MEMORY_UNSUPPORTED);
  const file = path.resolve(dbPath);
  // A leftover journal or WAL beside the target belongs to some earlier database; refuse it.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(file + suffix)) throw new Error(`Refusing to initialize: ${file + suffix} already exists. Remove leftover SQLite files first.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try { fd = fs.openSync(file, 'wx', 0o600); } // credentials live here: owner-only where the OS honours modes
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Refusing to initialize: ${file} already exists. db:init only creates new databases; use db:migrate for an existing one.`);
    throw error;
  }
  fs.closeSync(fd);
  let provisioned = false;
  try {
    const raw = new Database(file, { fileMustExist: true, timeout: 5000 });
    try {
      raw.transaction(() => provisionFreshSafetySchema(raw)).immediate();
      provisioned = true;
    } finally { raw.close(); }
  } catch (error) {
    // Only an unprovisioned file this call created exclusively is removed; once the safety
    // schema has committed, another process may already be using it.
    if (!provisioned) {
      const cleanup: unknown[] = [];
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { fs.rmSync(file + suffix, { force: true }); } catch (rmError) { cleanup.push(rmError); }
      }
      if (cleanup.length) throw new AggregateError([error, ...cleanup], `Database provisioning failed and ${file} could not be removed; delete it before retrying`);
    }
    throw error;
  }
  return file;
}

async function main(): Promise<void> {
  const { env } = await import('../config/env.js');
  const file = await createFreshDatabase(env.DATABASE_URL.slice('sqlite:'.length));
  // Build and validate the remaining schema exactly as server start would.
  const { initDatabase, closeDatabase } = await import('./client.js');
  let initError: unknown;
  try { initDatabase(); } catch (error) { initError = error; }
  try { closeDatabase(); } catch (closeError) {
    if (initError) throw new AggregateError([initError, closeError], 'Database initialization and cleanup failed');
    throw closeError;
  }
  if (initError) throw initError;
  console.log(`Initialized new database: ${file}`);
}

function describe(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(e => `  - ${describe(e)}`)].join('\n');
  return error instanceof Error ? error.message : String(error);
}

// Compare real paths: Node resolves the main module through symlinks, and drive-letter case may differ.
const entry = process.argv[1] ? (() => { try { return fs.realpathSync(process.argv[1]); } catch { return path.resolve(process.argv[1]); } })() : '';
if (entry && fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase() === entry.toLowerCase()) {
  main().catch(error => { console.error(describe(error)); process.exitCode = 1; });
}
