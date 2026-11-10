// Staged for review only. The executable remains hard-disabled until separately approved.
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED = ['--backup-verified', '--all-routers-stopped', '--no-outstanding-work', '--legacy-schema-provenance-verified', '--single-host-trusted-directory'];
const OPERATIONALLY_ENABLED = false;
const direct = Boolean(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);
let migrateLegacy429, assert429V2Schema, assertTokenUsageSchema, SQL_SCHEMA, ReferenceDatabase;
// A direct disabled invocation must not load migration or SQLite dependencies.
// Importing this module for the injectable helper is not a security boundary.
if (!direct || OPERATIONALLY_ENABLED) {
  ({migrateLegacy429} = await import('../src/db/offline-429-migration.mjs'));
  ({assert429V2Schema} = await import('../src/db/account-429-v2-store.ts'));
  ({assertTokenUsageSchema, SQL_SCHEMA} = await import('../src/db/schema.ts'));
  ({default: ReferenceDatabase} = await import('better-sqlite3'));
}

// The pre-429 variant is intentionally restricted to the complete known
// historical schema after OPEN provisioning. Provenance is an operator claim:
// exact schema alone cannot prove that later cooldown evidence was not deleted.
function prepareHistoricalPre429(db) {
  const refuse = () => { throw new Error('Unsafe historical pre-429 baseline'); };
  if (!db.inTransaction || db.pragma('user_version',{simple:true})!==0 || db.pragma('application_id',{simple:true})!==0 || db.pragma('encoding',{simple:true})!=='UTF-8' || db.pragma('ignore_check_constraints',{simple:true})!==0 || db.pragma('database_list').some(x=>!['main','temp'].includes(x.name))) refuse();
  // Compare SQLite's complete stored SQL text, not whitespace-stripped tokens:
  // token adjacency and comments can change meaning. This is intentionally
  // stricter than semantic equivalence and may reject other valid baselines.
  const objects=connection=>connection.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  if(db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get())refuse();
  const reference=new ReferenceDatabase(':memory:');
  let failed=false, failure, cleanupFailed=false, cleanupFailure;
  try {
    reference.exec(fs.readFileSync(new URL('./legacy-740df93-schema.sql',import.meta.url),'utf8'));
    reference.exec(`CREATE TABLE main.ordinary_account_attempts (
      account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
    );
    CREATE TABLE main.ordinary_attempts_schema_marker (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
    );
    CREATE TABLE main.siwc_account_attempts (
      account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
    );
    CREATE TABLE main.siwc_attempts_schema_marker (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
    );`);
    if(JSON.stringify(objects(db))!==JSON.stringify(objects(reference)))refuse();
  } catch(error) {failed=true;failure=error;}
  try {
    reference.close();
    if(reference.open!==false)throw new Error('Historical reference close uncertain');
  } catch(error) {cleanupFailed=true;cleanupFailure=error;}
  if(cleanupFailed)throw new AggregateError([...(failed?[failure]:[]),cleanupFailure],'Historical reference cleanup failed');
  if(failed)throw failure;
  if(db.pragma('quick_check',{simple:true})!=='ok' || db.pragma('foreign_key_check').length)refuse();
  for(const [table,expected] of [['quota_migration_marker','1'],['ordinary_attempts_schema_marker','1,1'],['siwc_attempts_schema_marker','1,1']]) {
    const rows=db.prepare(`SELECT * FROM main.${table}`).safeIntegers().all();
    if(rows.length!==1 || Object.values(rows[0]).map(String).join(',')!==expected)refuse();
  }
  db.exec(`CREATE TABLE main.account_429_cooldowns (
  kind TEXT NOT NULL, account_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(kind, account_id)
)`);
}

// Only this last committed legacy DDL and its two application indexes are
// supported. Unknown views/triggers and inbound references are refused rather
// than guessed at or rewritten. All checks and writes run under the CLI's lock.
function migrateLegacyUsage(db) {
  const fail = detail => { throw new Error(`Unsafe offline usage migration: ${detail}`); };
  const compact = s => {
    if (typeof s !== 'string' || s.replace(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),]|\s+/g, '') !== '') return null;
    return JSON.stringify(s.match(/[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[(),]/g)?.map(x=>x.toLowerCase()));
  };
  const legacy = `CREATE TABLE usage_logs ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, upstream_account_id TEXT NOT NULL, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, model TEXT NOT NULL, provider TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, success BOOLEAN NOT NULL, error TEXT, latency_ms INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE )`;
  const indexes = {
    idx_usage_logs_user_timestamp:'CREATE INDEX idx_usage_logs_user_timestamp ON usage_logs(user_id, timestamp DESC)',
    idx_usage_logs_account_timestamp:'CREATE INDEX idx_usage_logs_account_timestamp ON usage_logs(upstream_account_id, timestamp DESC)',
  };
  const knownTriggers = {
    protect_user_usage_history:"CREATE TRIGGER protect_user_usage_history BEFORE DELETE ON users WHEN EXISTS (SELECT 1 FROM usage_logs WHERE user_id = OLD.id) OR EXISTS (SELECT 1 FROM user_daily_quota WHERE user_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'user has usage history'); END",
    protect_account_usage_history:"CREATE TRIGGER protect_account_usage_history BEFORE DELETE ON upstream_accounts WHEN EXISTS (SELECT 1 FROM usage_logs WHERE upstream_account_id = OLD.id) BEGIN SELECT RAISE(ABORT, 'account has usage history'); END",
    upstream_credential_revision:'CREATE TRIGGER upstream_credential_revision AFTER UPDATE OF credentials, credential_type ON upstream_accounts BEGIN UPDATE upstream_accounts SET credential_revision = credential_revision + 1 WHERE id = NEW.id; END',
    upstream_state_revision:['CREATE TRIGGER upstream_state_revision AFTER UPDATE OF status, last_error ON upstream_accounts BEGIN UPDATE upstream_accounts SET state_revision = state_revision + 1 WHERE id = NEW.id; END','CREATE TRIGGER upstream_state_revision AFTER UPDATE OF status, last_error ON upstream_accounts WHEN NEW.request_revision = OLD.request_revision BEGIN UPDATE upstream_accounts SET state_revision = state_revision + 1 WHERE id = NEW.id; END'],
  };
  const normalize = s => typeof s === 'string' ? s.replace(/\s+/g,' ').trim() : '';
  const saved = [];
  for (const schema of ['main','temp']) {
    const objects=db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema`).all();
    for (const o of objects) {
      if (o.name.toLowerCase()==='offline_usage_legacy') fail(`reserved object ${schema}.${o.name}`);
      if (schema==='temp' && (o.name.toLowerCase()==='usage_logs' || o.tbl_name.toLowerCase()==='usage_logs')) fail(`temporary object ${o.name}`);
      if (o.type==='view') fail(`unsupported view ${schema}.${o.name}`);
      if (o.type==='trigger') {
        if (schema!=='main' || !Object.hasOwn(knownTriggers,o.name) || ![knownTriggers[o.name]].flat().some(sql=>normalize(o.sql)===normalize(sql))) fail(`unsupported trigger ${schema}.${o.name}`);
        if (o.name.startsWith('protect_')) saved.push(o);
      }
      if (o.type==='table' && o.name.toLowerCase()!=='usage_logs') {
        const q='"'+o.name.replace(/"/g,'""')+'"';
        if (db.prepare(`PRAGMA ${schema}.foreign_key_list(${q})`).all().some(f=>f.table.toLowerCase()==='usage_logs')) fail(`inbound foreign key from ${schema}.${o.name}`);
      }
      if (o.tbl_name.toLowerCase()==='usage_logs' && o.type==='index') {
        if (o.name==='sqlite_autoindex_usage_logs_1' && o.sql===null) continue;
        if (!Object.hasOwn(indexes,o.name) || compact(o.sql)!==compact(indexes[o.name])) fail(`unsupported usage index ${o.name}`);
      }
    }
  }
  const table=db.prepare("SELECT type,name,sql FROM main.sqlite_schema WHERE name='usage_logs' COLLATE NOCASE").get();
  if (!table || table.type!=='table' || table.name!=='usage_logs' || compact(table.sql)!==compact(legacy)) fail('unrecognized legacy usage_logs DDL');
  for (const [name,sql] of Object.entries(indexes)) {
    const index=db.prepare('SELECT type,tbl_name,sql FROM main.sqlite_schema WHERE name=?').get(name);
    if (!index || index.type!=='index' || index.tbl_name!=='usage_logs' || compact(index.sql)!==compact(sql)) fail(`missing or incompatible index ${name}`);
  }
  if (db.prepare("SELECT 1 FROM main.usage_logs WHERE typeof(input_tokens)!='integer' OR typeof(output_tokens)!='integer' LIMIT 1").get()) fail('non-integer legacy token values unsupported');
  const create=SQL_SCHEMA.match(/CREATE TABLE IF NOT EXISTS usage_logs \([\s\S]*?\n\);/)?.[0];
  if (!create) fail('target schema unavailable');
  for (const t of saved) db.exec(`DROP TRIGGER main."${t.name}"`);
  for (const name of Object.keys(indexes)) db.exec(`DROP INDEX main."${name}"`);
  db.exec('ALTER TABLE main.usage_logs RENAME TO offline_usage_legacy');
  db.exec(create);
  const columns=['id','user_id','upstream_account_id','timestamp','model','provider','input_tokens','output_tokens','success','error','latency_ms'];
  const list=columns.join(',');
  db.exec(`INSERT INTO main.usage_logs (rowid,${list},usage_known) SELECT rowid,${list},NULL FROM main.offline_usage_legacy`);
  const mismatch=columns.map(c=>`typeof(a.${c})!=typeof(b.${c}) OR a.${c} IS NOT b.${c}`).join(' OR ');
  if (db.prepare(`SELECT 1 FROM main.offline_usage_legacy a LEFT JOIN main.usage_logs b ON a.rowid=b.rowid WHERE b.rowid IS NULL OR ${mismatch} LIMIT 1`).get() || db.prepare('SELECT (SELECT count(*) FROM main.offline_usage_legacy)!=(SELECT count(*) FROM main.usage_logs) AS bad').get().bad) fail('copied usage rows differ');
  db.exec('DROP TABLE main.offline_usage_legacy');
  for (const sql of Object.values(indexes)) db.exec(sql);
  for (const t of saved) db.exec(t.sql);
  assertTokenUsageSchema(db);
  if (db.pragma('foreign_key_check').length) fail('foreign_key_check failed');
}

// Dependencies are injectable only for owned in-memory tests. Production uses
// the concrete fs and SQLite adapters below; no fault callback is forwarded.
function checkedTarget(args, required, paths, platform, pathDiagnostic = 'An absolute database path is required') {
  if (!Array.isArray(args) || args.length !== required.length + 1 || required.some(f => args.filter(x => x === f).length !== 1)) throw new Error('Required attestations missing');
  const remaining = args.filter(x => !required.includes(x));
  const input = remaining[0];
  const windows = platform === 'win32';
  const fullyQualifiedWindows = value => /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/?*:|"<>\x00-\x1f]+[\\/][^\\/?*:|"<>\x00-\x1f]+(?:[\\/]|$)/.test(value);
  const unsafeWindowsComponent = windows && typeof input === 'string' && input.split(/[\\/]/).slice(1).some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  if (remaining.length !== 1 || typeof input !== 'string' || input.startsWith('--') || /^file:/i.test(input) || input.includes('\0') || (windows ? /[\\/]$/.test(input) : /\/$/.test(input)) || !paths.isAbsolute(input) || (windows && (!fullyQualifiedWindows(input) || unsafeWindowsComponent)) || input.split(windows ? /[\\/]/ : /\//).some(part => part === '.' || part === '..')) throw new Error(pathDiagnostic);
  return paths.resolve(input);
}

export function runOffline429(args, {fs: io, path: paths, openDatabase, platform}) {
  const pre429 = Array.isArray(args) && args.includes('--genuinely-pre-429');
  const target = checkedTarget(args, pre429 ? [...REQUIRED,'--genuinely-pre-429'] : REQUIRED, paths, platform, 'An absolute existing database path is required');
  // Best effort only: these checks cannot establish SQLite's opened identity
  // or prevent path replacement races, hard links, or all ancestor races.
  function identity() {
    const root = paths.parse(target).root;
    let current = root;
    const parts = [root, ...target.slice(root.length).split(paths.sep).filter(Boolean)];
    return parts.map((part, i) => {
      if (i) current = paths.join(current, part);
      const st = io.lstatSync(current, {bigint:true});
      if (st.isSymbolicLink() || (i === parts.length - 1 ? !st.isFile() || st.nlink !== 1n : !st.isDirectory()) || st.ino === 0n) throw new Error('Unsafe database path');
      return `${st.dev}:${st.ino}`;
    });
  }
  const before = identity();
  const recheck = () => {
    const descriptor = io.fstatSync(fd, {bigint:true});
    if (!descriptor.isFile() || descriptor.nlink !== 1n || `${descriptor.dev}:${descriptor.ino}` !== before.at(-1) || JSON.stringify(identity()) !== JSON.stringify(before)) throw new Error('Database path changed');
  };
  let fd, db, failure, failed = false, committed = false;
  try {
    fd = io.openSync(target, io.constants.O_RDONLY | (platform === 'win32' ? 0 : (io.constants.O_NOFOLLOW || 0)));
    const st = io.fstatSync(fd, {bigint:true});
    if (!st.isFile() || st.nlink !== 1n || `${st.dev}:${st.ino}` !== before.at(-1)) throw new Error('Database identity changed');
    recheck();
    db = openDatabase(target, {fileMustExist:true, timeout:1000});
    recheck();
    if (db.inTransaction) throw new Error('Top-level transaction required');
    db.transaction(() => {
      recheck();
      if(pre429) prepareHistoricalPre429(db);
      migrateLegacy429(db);
      assert429V2Schema(db);
      migrateLegacyUsage(db);
      assert429V2Schema(db);
      assertTokenUsageSchema(db);
      if (db.pragma('foreign_key_check').length) throw new Error('Unsafe offline migration: foreign_key_check failed');
      recheck();
    }).immediate();
    committed = true;
  } catch (error) { failed = true; failure = error; }
  const cleanup = [];
  try { if (db) { db.close(); if (db.open !== false) throw new Error('SQLite close uncertain'); } } catch (error) { cleanup.push(error); }
  try { if (fd !== undefined) io.closeSync(fd); } catch (error) { cleanup.push(error); }
  if (cleanup.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanup], committed
    ? 'Commit confirmed; cleanup failed or close uncertain. Inspect handles and database; do not retry migration.'
    : 'Migration failed; cleanup failed or close uncertain. Commit outcome may be uncertain; inspect handles and database.');
  if (failed) throw failure;
}

const FRESH_REQUIRED = ['--brand-new-database-provenance-verified', '--all-routers-stopped', '--single-host-trusted-directory'];

// Test seam only; not a security boundary against malicious adapter wrappers.
// The disabled production branch calls the internal implementation with concrete
// adapters and the real provisioning function, not caller-provided hooks.
export function runFreshBootstrap(args, adapters) {
  if (adapters?.fs === fs) throw new Error('Concrete filesystem adapter is reserved for the disabled production branch');
  return bootstrapFreshInternal(args, adapters);
}
function bootstrapFreshInternal(args, {fs: io, path: paths, platform, openDatabase, provision}) {
  // SQLite opens by name: these identity checks cannot prevent replacement or
  // ancestor races. The attested single-host trusted directory is essential.
  const target = checkedTarget(args, FRESH_REQUIRED, paths, platform);
  const root = paths.parse(target).root;
  const parts = [root, ...target.slice(root.length).split(paths.sep).filter(Boolean)];
  function identity(includeFile) {
    let current = root;
    return parts.slice(0, includeFile ? parts.length : -1).map((part, i) => {
      if (i) current = paths.join(current, part);
      const st = io.lstatSync(current, {bigint:true});
      const file = includeFile && i === parts.length - 1;
      if (st.isSymbolicLink() || (file ? !st.isFile() || st.nlink !== 1n : !st.isDirectory()) || st.ino === 0n) throw new Error('Unsafe database path');
      return `${st.dev}:${st.ino}`;
    });
  }
  const parent = identity(false);
  let fd, db, created = false, failure, failed = false;
  try {
    // Atomic exclusive creation: never check existence then create or overwrite.
    fd = io.openSync(target, 'wx', 0o600);
    created = true;
    const before = identity(true);
    const stat = io.fstatSync(fd, {bigint:true});
    if (!stat.isFile() || stat.nlink !== 1n || `${stat.dev}:${stat.ino}` !== before.at(-1) || JSON.stringify(before.slice(0,-1)) !== JSON.stringify(parent)) throw new Error('Database identity changed');
    const recheck = () => {
      const st = io.fstatSync(fd, {bigint:true});
      if (!st.isFile() || st.nlink !== 1n || `${st.dev}:${st.ino}` !== before.at(-1) || JSON.stringify(identity(true)) !== JSON.stringify(before)) throw new Error('Database path changed');
    };
    recheck();
    db = openDatabase(target, {fileMustExist:true, timeout:1000});
    recheck();
    if (db.inTransaction) throw new Error('Top-level transaction required');
    db.transaction(() => { recheck(); provision(db); recheck(); }).immediate();
  } catch (error) { failed = true; failure = error; }
  const cleanup = [];
  try { if (db) { db.close(); if (db.open !== false) throw new Error('SQLite close uncertain'); } } catch (error) { cleanup.push(error); }
  try { if (fd !== undefined) io.closeSync(fd); } catch (error) { cleanup.push(error); }
  if (failed || cleanup.length) {
    const note = created ? 'Created path retained; stop and inspect identity and SQLite state before any manual cleanup; commit outcome may be uncertain.' : 'No file was created by this operation.';
    throw new AggregateError([...(failed ? [failure] : []), ...cleanup], note);
  }
}

if (direct && process.argv[2] === '--fresh-bootstrap') {
  // This branch remains independently hard-disabled, including dependency imports.
  const FRESH_OPERATIONALLY_ENABLED = false;
  if (!FRESH_OPERATIONALLY_ENABLED) {
    console.error('Fresh bootstrap is disabled pending independent review and explicit authorization.');
    process.exitCode = 1;
  } else {
    try {
      const [{default: Database}, {provisionFreshSafetySchema}] = await Promise.all([
        import('better-sqlite3'), import('../src/db/client.ts')
      ]);
      bootstrapFreshInternal(process.argv.slice(3), {fs, path, platform:process.platform,
        openDatabase: (file, options) => new Database(file, options), provision:provisionFreshSafetySchema});
      console.log('Fresh safety schema committed; ordinary startup may initialize the remaining schema.');
    } catch {
      console.error('Fresh bootstrap refused or failed. A created path is retained; inspect its identity and SQLite state before manual cleanup. Commit outcome may be uncertain.');
      process.exitCode = 1;
    }
  }
} else if (direct) {
  if (!OPERATIONALLY_ENABLED) {
    console.error('Offline 429 upgrade is disabled pending independent review and explicit authorization.');
    process.exitCode = 1;
  } else {
    try {
      const {default: Database} = await import('better-sqlite3');
      runOffline429(process.argv.slice(2), {fs, path, platform:process.platform, openDatabase: (file, options) => new Database(file, options)});
      console.log('Offline 429 migration committed. Legacy rows and OPENs retained.');
    } catch (error) {
      if (error instanceof AggregateError && error.message.startsWith('Commit confirmed;')) {
        console.error('Offline 429 migration commit confirmed, but cleanup failed or close is uncertain. Do not retry; inspect handles and database.');
      } else {
        console.error('Offline 429 migration refused or failed. Commit outcome may be uncertain; inspect the database and verified backup.');
      }
      process.exitCode = 1;
    }
  }
}
