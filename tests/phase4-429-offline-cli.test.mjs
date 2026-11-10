import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const moduleUrl = new URL('../scripts/offline-429-upgrade.mjs', import.meta.url);
test('missing operator attestations refuse before filesystem or database access', async () => {
  let cli;
  try { cli = await import(moduleUrl); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('offline-429-upgrade.mjs')) assert.fail('offline 429 entrypoint is missing');
    throw e;
  }
  let touched = false;
  const forbidden = () => { touched = true; throw new Error('unexpected access'); };
  assert.throws(() => cli.runOffline429([], {fs: {lstatSync: forbidden}, openDatabase: forbidden, path: path.posix}));
  assert.equal(touched, false);
});

const flags = ['--backup-verified','--all-routers-stopped','--no-outstanding-work','--legacy-schema-provenance-verified','--single-host-trusted-directory'];
const target = '/safe/router.db';

test('lexical dot segments and incomplete Windows roots refuse before filesystem access', async () => {
  const {runOffline429} = await import(moduleUrl);
  const cases = [
    [path.posix, 'linux', '/safe/link/../router.db'],
    [path.posix, 'linux', '/safe/./router.db'],
    [path.posix, 'linux', '/safe/router.db/'],
    [path.win32, 'win32', 'C:\\safe\\router.db\\'],
    [path.win32, 'win32', 'C:/safe/router.db/'],
    [path.win32, 'win32', 'C:\\safe\\link\\..\\router.db'],
    [path.win32, 'win32', 'C:/safe/./router.db'],
    [path.win32, 'win32', 'C:\\safe/../router.db'],
    [path.win32, 'win32', '\\data\\foo'],
    [path.win32, 'win32', 'C:foo'],
    [path.win32, 'win32', '\\\\server'],
    [path.win32, 'win32', '\\\\server\\\\share\\router.db'],
    [path.win32, 'win32', '\\\\server\\share:bad\\router.db'],
    [path.win32, 'win32', '\\\\?\\C:\\safe\\router.db'],
    [path.win32, 'win32', '//?/C:/safe/router.db'],
    [path.win32, 'win32', '\\\\.\\C:\\safe\\router.db'],
  ];
  const results = cases.map(([paths, platform, input]) => {
    let touched = false, category = 'no error';
    const forbidden = () => { touched = true; throw new Error('unexpected access'); };
    try { runOffline429([...flags,input], {path:paths,platform,fs:{lstatSync:forbidden},openDatabase:forbidden}); }
    catch (e) { category = e.message; }
    return {input, touched, rejected:category === 'An absolute existing database path is required'};
  });
  assert.deepEqual(results, cases.map(([, , input]) => ({input, touched:false, rejected:true})));
});

test('valid dotted filenames and fully qualified Windows paths reach injected filesystem', async () => {
  const {runOffline429} = await import(moduleUrl);
  for (const [paths, platform, input] of [
    [path.posix,'linux','/safe/.../router.db'],
    [path.win32,'win32','C:\\safe\\router.db'],
    [path.win32,'win32','C:/safe/router.db'],
    [path.win32,'win32','\\\\server\\share\\router.db'],
  ]) {
    let touched = false;
    const stop = () => { touched = true; throw new Error('injected filesystem reached'); };
    assert.throws(() => runOffline429([...flags,input], {path:paths,platform,fs:{lstatSync:stop},openDatabase:stop}), /injected filesystem reached/);
    assert.equal(touched, true);
  }
});

test('direct executable remains disabled before migration dependencies', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(moduleUrl), ...flags, target], {
    cwd: fileURLToPath(new URL('..', moduleUrl)), env: {}, encoding:'utf8', timeout:5000, maxBuffer:4096,
    windowsHide:true,
  });
  assert.equal(child.error === undefined, true, 'child spawn or timeout failure');
  assert.equal(child.signal, null, 'child did not exit normally');
  assert.equal(typeof child.status === 'number' && child.status !== 0, true, 'disabled child must exit nonzero');
  assert.equal(child.stdout === '', true, 'unexpected child stdout');
  assert.equal(child.stderr.trim() === 'Offline 429 upgrade is disabled pending independent review and explicit authorization.', true, 'disabled diagnostic missing or dependency loader failed');
});
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE upstream_accounts (id TEXT PRIMARY KEY);
  CREATE TABLE usage_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, upstream_account_id TEXT NOT NULL, timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, model TEXT NOT NULL, provider TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, success BOOLEAN NOT NULL, error TEXT, latency_ms INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (upstream_account_id) REFERENCES upstream_accounts(id) ON DELETE CASCADE);
  CREATE INDEX idx_usage_logs_user_timestamp ON usage_logs(user_id, timestamp DESC);
  CREATE INDEX idx_usage_logs_account_timestamp ON usage_logs(upstream_account_id, timestamp DESC);
  CREATE TABLE account_429_cooldowns (
    kind TEXT NOT NULL, account_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    PRIMARY KEY(kind, account_id)
  );
  CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
  CREATE TABLE ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
  CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
  CREATE TABLE siwc_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
  INSERT INTO ordinary_attempts_schema_marker VALUES (1,1);
  INSERT INTO siwc_attempts_schema_marker VALUES (1,1);
  INSERT INTO ordinary_account_attempts VALUES ('ordinary-open','attempt-a');
  INSERT INTO siwc_account_attempts VALUES ('siwc-open','attempt-b');
  INSERT INTO account_429_cooldowns VALUES ('upstream','a',1,2,1),('siwc','a',3,4,2),('upstream','orphan',5,6,3);`);
  return db;
}
const snapshot = db => ['account_429_cooldowns','ordinary_account_attempts','ordinary_attempts_schema_marker','siwc_account_attempts','siwc_attempts_schema_marker'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
function harness(db, {fault = false, badPath = false} = {}) {
  const calls = [];
  let afterWrite = false, fakeOpen = true;
  const stat = (ino, file, link = false) => ({dev:1n,ino:BigInt(ino),nlink:1n,isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>link});
  const entries = {'/':stat(1,false),'/safe':stat(2,false,badPath),[target]:stat(3,true)};
  const io = {
    constants:{O_RDONLY:0,O_NOFOLLOW:16},
    lstatSync(p) { calls.push(['lstat',p]); if (!(p in entries)) throw new Error('path not allowlisted'); return entries[p]; },
    openSync(p, flags) { calls.push(['open',p,flags]); assert.equal(p,target); return 9; },
    fstatSync(fd) { assert.equal(fd,9); return entries[target]; },
    closeSync(fd) { assert.equal(fd,9); calls.push(['close']); },
  };
  const proxy = new Proxy(db, {get(obj, key) {
    if (key === 'open') return fakeOpen;
    if (key === 'close') return () => { calls.push(['db-close']); fakeOpen = false; };
    if (key === 'prepare' && fault) return sql => {
      const stmt = obj.prepare(sql);
      if (!sql.startsWith('INSERT INTO main.account_429_v2_restrictions VALUES')) return stmt;
      return {run(...args) { const result = stmt.run(...args); afterWrite = obj.prepare('SELECT count(*) n FROM main.account_429_v2_restrictions').get().n === 1; obj.exec('INSERT INTO no_such_table VALUES (1)'); return result; }};
    };
    const v = obj[key]; return typeof v === 'function' ? v.bind(obj) : v;
  }});
  const deps = {fs:io,path:path.posix,platform:'linux',openDatabase(p, opts) { calls.push(['db-open',p,opts]); assert.equal(p,target); assert.deepEqual(opts,{fileMustExist:true,timeout:1000}); return proxy; }};
  return {deps,calls,afterWrite:()=>afterWrite,connection:proxy};
}

test('each missing attestation and invalid argument refuses before filesystem or database access', async () => {
  const {runOffline429} = await import(moduleUrl);
  for (const args of [[], ...flags.map(f => [...flags.filter(x=>x!==f),target]), [...flags, flags[0], target], [...flags,'file:/safe/router.db'], [...flags,'relative.db']]) {
    const db=fixture(), h=harness(db);
    try { assert.throws(() => runOffline429(args,h.deps)); assert.deepEqual(h.calls,[]); } finally { db.close(); }
  }
});

test('approved simulated invocation commits all legacy rows as indefinite and preserves OPENs', async () => {
  const {runOffline429} = await import(moduleUrl);
  const db=fixture(), h=harness(db), before=snapshot(db);
  try {
    assert.equal(h.connection.open,true);
    runOffline429([...flags,target],h.deps);
    assert.equal(h.connection.open,false);
    assert.equal(db.open,true);
    assert.equal(h.calls.filter(x=>x[0]==='db-close').length,1);
    const {assert429V2Schema} = await import('../src/db/account-429-v2-store.ts');
    assert.equal(assert429V2Schema(db),3n);
    assert.deepEqual(db.prepare('SELECT kind,account_id,duration_ms FROM account_429_v2_restrictions ORDER BY kind,account_id').all(),[
      {kind:'siwc',account_id:'a',duration_ms:null},{kind:'upstream',account_id:'a',duration_ms:null},{kind:'upstream',account_id:'orphan',duration_ms:null}
    ]);
    assert.deepEqual(snapshot(db),before);
    assert.equal(db.inTransaction,false);
    assert.equal(h.calls.filter(x=>x[0]==='db-open').length,1);
  } finally { db.close(); }
});

test('SQL failure after a real v2 row write rolls back schema and legacy state', async () => {
  const {runOffline429} = await import(moduleUrl);
  const db=fixture(), h=harness(db,{fault:true}), before=snapshot(db);
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  try {
    assert.equal(h.connection.open,true);
    assert.throws(() => runOffline429([...flags,target],h.deps), /no such table/);
    assert.equal(h.connection.open,false);
    assert.equal(db.open,true);
    assert.equal(h.calls.filter(x=>x[0]==='db-close').length,1);
    assert.equal(h.afterWrite(),true);
    assert.equal(db.inTransaction,false);
    assert.deepEqual(snapshot(db),before);
    assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),schema);
  } finally { db.close(); }
});

test('synthetic symlink ancestor is rejected before database or file open', async () => {
  const {runOffline429} = await import(moduleUrl);
  const db=fixture(), h=harness(db,{badPath:true});
  try { assert.throws(() => runOffline429([...flags,target],h.deps), /Unsafe database path/); assert.equal(h.calls.some(x=>x[0]==='open'||x[0]==='db-open'),false); } finally { db.close(); }
});
