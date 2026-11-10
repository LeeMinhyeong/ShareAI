// Explicit offline operation only; never imported by application startup.
import Database from 'better-sqlite3';
import { readFileSync, lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import path from 'node:path';

const required = ['--all-routers-stopped', '--no-outstanding-work', '--backup-verified'];
const baselines = ['--genuinely-pre-open', '--genuinely-pre-siwc-open'];
const args = process.argv.slice(2);
const selected = baselines.filter(flag => args.filter(x => x === flag).length === 1);
if (args.length !== 5 || required.some(flag => args.filter(x => x === flag).length !== 1) || selected.length !== 1 || args.filter(x => !x.startsWith('--')).length !== 1) {
  console.error('Required operator attestations: --all-routers-stopped --no-outstanding-work --backup-verified and exactly one of --genuinely-pre-open or --genuinely-pre-siwc-open, followed by an existing database path.');
  process.exit(1);
}
const preOpen = selected[0] === '--genuinely-pre-open';
console.error('WARNING: schema cannot prove provenance or absence of lost OPEN work. SQLite locks cannot prevent old router versions from reconnecting later. All routers must stay stopped until cutover; versions cannot be enforced.');
const file = args.find(x => !x.startsWith('--'));
// Compare every sqlite_schema object and SQL token, including implicit indexes.
// Quoted strings are indivisible: whitespace inside a literal is significant.
function tokens(sql) {
  if (sql === null) return null;
  return JSON.stringify(sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g));
}
function schema(db) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all().map(o => ({...o,sql:tokens(o.sql)}));
}
function pathIdentity(input) {
  if (/^file:/i.test(input) || input.includes('\0')) throw new Error('Database URI is not permitted');
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  let current = root;
  const components = [root, ...absolute.slice(root.length).split(path.sep).filter(Boolean)];
  return components.map((part, index) => {
    if (index) current = path.join(current, part);
    const s = lstatSync(current, {bigint:true});
    if (s.isSymbolicLink() || (index < components.length - 1 ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n)) throw new Error('Unsafe database path');
    if (s.ino === 0n) throw new Error('File identity unavailable');
    return `${s.dev}:${s.ino}`;
  });
}
let db, reference, fd;
try {
  const identity = pathIdentity(file);
  const target = path.resolve(file);
  fd = openSync(target, constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW || 0)));
  const opened = fstatSync(fd, {bigint:true});
  if (!opened.isFile() || opened.nlink !== 1n || `${opened.dev}:${opened.ino}` !== identity.at(-1)) throw new Error('Database identity changed');
  const checkIdentity = () => {
    const current = fstatSync(fd,{bigint:true});
    if (!current.isFile() || current.nlink !== 1n || `${current.dev}:${current.ino}` !== identity.at(-1) || JSON.stringify(pathIdentity(file)) !== JSON.stringify(identity)) throw new Error('Database path changed');
  };
  checkIdentity();
  reference = new Database(':memory:');
  reference.exec(readFileSync(new URL('./legacy-740df93-schema.sql', import.meta.url), 'utf8'));
  let expected;
  if (preOpen) {
    expected = [JSON.stringify(schema(reference))];
  } else {
    reference.exec(`CREATE TABLE main.ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
      CREATE TABLE main.ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));`);
    const recorded = JSON.parse(readFileSync(new URL('./current-ordinary-only-schema.json', import.meta.url), 'utf8'));
    expected = [JSON.stringify(schema(reference)), JSON.stringify(recorded.map(o => ({...o, sql:tokens(o.sql)})))];
  }
  db = new Database(target, {fileMustExist:true, timeout:1000});
  checkIdentity();
  db.pragma('synchronous = FULL');
  db.transaction(() => {
    checkIdentity();
    if (db.pragma('user_version', {simple:true}) !== 0 || db.pragma('application_id', {simple:true}) !== 0 || db.pragma('encoding', {simple:true}) !== 'UTF-8') throw new Error('Unrecognized database metadata');
    if (!expected.includes(JSON.stringify(schema(db)))) throw new Error('Unrecognized schema or target collision');
    if (db.pragma('quick_check', {simple:true}) !== 'ok') throw new Error('Database integrity check failed');
    if (db.pragma('foreign_key_check').length) throw new Error('Database foreign key check failed');
    const marker = db.prepare('SELECT id FROM main.quota_migration_marker').all();
    if (marker.length !== 1 || marker[0].id !== 1) throw new Error('Legacy quota initialization marker missing');
    if (preOpen) db.exec(`CREATE TABLE main.ordinary_account_attempts (
      account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
    );
    CREATE TABLE main.ordinary_attempts_schema_marker (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
    );
    INSERT INTO main.ordinary_attempts_schema_marker VALUES (1,1);`);
    else {
      const ordinary = db.prepare('SELECT id,version FROM main.ordinary_attempts_schema_marker').all();
      if (ordinary.length !== 1 || ordinary[0].id !== 1 || ordinary[0].version !== 1) throw new Error('Ordinary marker missing or invalid');
      // Only the recognized current baseline has this table; the historical
      // ordinary-only baseline predates account quota initialization.
      if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='account_quota_migration_marker'").get()) {
        const accountQuota = db.prepare('SELECT id FROM main.account_quota_migration_marker').all();
        if (accountQuota.length !== 1 || accountQuota[0].id !== 1) throw new Error('Account quota marker missing or invalid');
      }
    }
    db.exec(`CREATE TABLE main.siwc_account_attempts (
      account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL
    );
    CREATE TABLE main.siwc_attempts_schema_marker (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1)
    );
    INSERT INTO main.siwc_attempts_schema_marker VALUES (1,1);`);
    checkIdentity();
  }).exclusive();
  console.log('Offline OPEN schema provisioned. Legacy rows were not modified.');
} catch (error) {
  // Do not print SQL, paths, rows, or credentials from database errors.
  console.error('Offline upgrade refused or failed. If commit outcome is uncertain, inspect the database and verified backup before proceeding.');
  process.exitCode = 1;
} finally {
  if (db) db.close();
  if (reference) reference.close();
  if (fd !== undefined) closeSync(fd);
}
