// Test-only disposable worker: no database path, SQL, callback, or fixture input.
import fs from 'node:fs';
import path from 'node:path';
import { extractFixture429 } from './real-app-429-extractor.mjs';
import { cleanupFixture } from './real-app-429-cleanup.mjs';
import { scenario as runScenario } from './real-app-429-scenario.mjs';

if (process.argv.length !== 2) throw new Error('Fixture worker accepts no arguments');
const root = process.env.TMPDIR;
if (!root || !path.isAbsolute(root)) throw new Error('Trusted TMPDIR must be an absolute directory');
const absoluteRoot = path.resolve(root);
// This fixture is intentionally pinned to this environment's trusted scratch root.
// A caller-controlled TMPDIR must not redirect a direct worker invocation.
const trustedRoot = path.resolve('C:/Users/Administrator/AppData/Local/hermes/cache/scratch');
if (process.platform !== 'win32' || absoluteRoot.toLowerCase() !== trustedRoot.toLowerCase()) {
  throw new Error('TMPDIR is not the trusted fixture scratch root');
}
// Refuse symlink/junction components instead of following an unexpected scratch root.
let current = path.parse(absoluteRoot).root;
for (const part of absoluteRoot.slice(current.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe TMPDIR component');
}
const dir = fs.mkdtempSync(path.join(absoluteRoot, 'real-app-429-'));
const file = path.join(dir, 'fixture.sqlite');
const previous = process.cwd();
let closeDatabase;
let result;
let failed = false;
let primary;
try {
  // Reserve a new file within our private directory before importing app configuration.
  fs.closeSync(fs.openSync(file, 'wx'));
  process.chdir(dir); // dotenv must never read the repository's or user's .env
  // Direct invocation must be just as isolated as invocation by the test.
  const pathEnv = process.env.PATH;
  const systemRoot = process.env.SystemRoot;
  for (const key of Object.keys(process.env)) delete process.env[key];
  if (pathEnv !== undefined) process.env.PATH = pathEnv;
  if (systemRoot !== undefined) process.env.SystemRoot = systemRoot;
  Object.assign(process.env, {
    HOME:dir, USERPROFILE:dir, TMPDIR:dir, TEMP:dir, TMP:dir,
    NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64),
    ADMIN_API_KEY:'synthetic-test-admin-key-only', LOG_LEVEL:'error', LOG_PRETTY:'false',
    PORT:'20100', HOST:'127.0.0.1', RATE_LIMIT_WINDOW_MS:'60000',
    RATE_LIMIT_MAX_FREE:'20', RATE_LIMIT_MAX_PRO:'100', CORS_ORIGIN:'http://synthetic.invalid',
  });
  const client = await import('../../src/db/client.ts');
  closeDatabase = client.closeDatabase;
  const db = client.initDatabase();
  // This table is created by the real SIWC login path, not client initialization.
  db.exec('CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.prepare(`INSERT INTO upstream_accounts
    (id,name,provider,credential_type,credentials,status,quota_reset_at,created_at,updated_at)
    VALUES ('shared','synthetic upstream','openai','api_key','synthetic-credential','active','2099-01-01','2020-01-01','2020-01-01')`).run();
  db.prepare("INSERT INTO siwc_accounts VALUES ('shared','synthetic siwc')").run();
  const { SiwcStore } = await import('../../src/upstream/siwc-store.ts');
  const store = new SiwcStore(db, {encrypt: value => value, decrypt: value => value}, {initialize:false});
  store.create('shared', {issuer:'https://auth.openai.com', subject:'synthetic-subject', clientId:'synthetic-client', accessToken:'synthetic-access', idToken:'synthetic-id', tokenType:'Bearer', expiresIn:3600, scopes:['openid'], savedAt:'2020-01-01T00:00:00.000Z'});
  db.prepare("UPDATE siwc_credentials SET revision='synthetic-revision' WHERE id='shared'").run();
  const insert = db.prepare('INSERT INTO account_429_cooldowns(kind,account_id,observed_at,until_at,revision) VALUES (?,?,?,?,?)');
  for (const row of [['siwc','orphan-s',1,2,4], ['siwc','shared',100,200,2], ['upstream','orphan-u',3,4,3], ['upstream','shared',1000,4102444800000,1]]) insert.run(...row);
  db.prepare("INSERT INTO ordinary_account_attempts VALUES ('shared','ordinary-open')").run();
  db.prepare("INSERT INTO siwc_account_attempts VALUES ('shared','siwc-open')").run();
  function snapshot() {
    const schema = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
    const rows = {};
    for (const {name} of schema.filter(object => object.type === 'table')) {
      const identifier = '"' + name.replaceAll('"','""') + '"';
      rows[name] = db.prepare(`SELECT * FROM main.${identifier} ORDER BY rowid`).all();
    }
    return {schema, rows, integrity:db.pragma('integrity_check',{simple:true}), foreignKeys:db.pragma('foreign_key_check'), journalMode:db.pragma('journal_mode',{simple:true})};
  }
  const before = snapshot();
  // A read-only snapshot and plan only: no production conversion is executed.
  const extracted = extractFixture429(db);
  // Every mutation is synthetic and rolled back on the worker-owned connection.
  function scenario(setup, check) { return runScenario(db, setup, check); }
  function rejected(setup) {
    return scenario(setup, () => {
      try { extractFixture429(db); return false; }
      catch (error) {
        if (error.message !== 'Unsafe 429 snapshot' && !(error instanceof TypeError && /encoded data/.test(error.message))) throw error;
        return true;
      }
    });
  }
  const validIds = ['Case','case','é界','x'.repeat(512)];
  const valid = scenario(() => {
    for (const id of validIds) insert.run('upstream',id,1,2,1);
  }, () => {
    const out = extractFixture429(db);
    return {...out.extractionCounts, ids:validIds.filter(id => out.cooldowns.some(row => row.kind === 'upstream' && row.account_id === id))};
  });
  const extractorCases = {
    valid,
    tooLong:rejected(() => insert.run('siwc','x'.repeat(513),1,2,1)),
    invalidUtf8:rejected(() => db.exec("INSERT INTO account_429_cooldowns VALUES ('siwc',CAST(x'80' AS TEXT),1,2,1)")),
    malformedSchema:rejected(() => db.exec('DROP TABLE account_429_cooldowns; CREATE TABLE account_429_cooldowns (kind TEXT, account_id TEXT, observed_at INTEGER, until_at INTEGER, revision INTEGER)')),
    unsafeInteger:rejected(() => db.exec("INSERT INTO account_429_cooldowns VALUES ('siwc','unsafe',9007199254740992,2,1)")),
    wrongType:rejected(() => db.exec("INSERT INTO account_429_cooldowns VALUES ('siwc','wrong',1.5,2,1)")),
    tempConflict:rejected(() => db.exec('CREATE TEMP TABLE account_429_cooldowns (id TEXT)')),
    trigger:rejected(() => db.exec('CREATE TRIGGER synthetic_429_trigger AFTER INSERT ON account_429_cooldowns BEGIN SELECT 1; END')),
    embeddedNul:rejected(() => insert.run('siwc','nul\0suffix',1,2,1)),
    longKind:rejected(() => insert.run('upstream-too-long','id',1,2,1)),
    tooMany:rejected(() => { for (let i=0;i<1021;i++) insert.run('siwc',`many-${i}`,1,2,1); }),
  };
  const after = snapshot();
  result = {before,after,...extracted,extractorCases};
} catch (error) {
  failed = true;
  primary = error;
}
cleanupFixture({
  close:closeDatabase, restore:() => process.chdir(previous),
  remove:() => fs.rmSync(dir,{recursive:true,force:true}), dir, failed, primary,
});
process.stdout.write(JSON.stringify(result));
