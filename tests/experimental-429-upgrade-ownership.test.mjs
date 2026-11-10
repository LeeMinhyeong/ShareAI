import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { convertSynthetic429 } from '../src/db/experimental-429-upgrade.mjs';

// Lexical validation is deliberately pure: invalid input triggers no filesystem access.
function validateScratchPath(value) {
  assert.ok(typeof value === 'string' && value.trim() && !value.includes('\0') && isAbsolute(value),
    'TMPDIR must be an absolute trusted test workspace');
  const normalized = resolve(value); // Strip trailing separators before lstat checks the root itself.
  assert.notEqual(normalized, parse(normalized).root, 'TMPDIR must not be a filesystem root');
  return normalized;
}

test('rejects the old caller-supplied database interface without calling it', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE legacy_cooldowns (kind TEXT NOT NULL, account_id TEXT NOT NULL, deadline INTEGER NOT NULL, PRIMARY KEY(kind,account_id));
CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);`);
    let calls = 0;
    const proxy = new Proxy(db, { get(target, key) {
      calls++;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    assert.throws(() => convertSynthetic429(proxy, {backupVerified:true, allRoutersStoppedAndFenced:true}));
    assert.throws(() => convertSynthetic429(proxy), /Expected a JSON fixture string/);
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'experimental_atomic_429_%'").get().n, 0);
  } finally { db.close(); }
});

test('scratch path validation rejects missing and unsafe lexical inputs without filesystem access', () => {
  for (const value of [undefined, '', 'relative/path', '/', '\0']) {
    assert.throws(() => validateScratchPath(value), /TMPDIR/);
  }
  assert.equal(validateScratchPath(join(process.cwd(), 'trusted-test-workspace')), join(process.cwd(), 'trusted-test-workspace'));
});

test('spoofed proxy is not accessed and checked fixture rows, schema and journal mode remain unchanged', () => {
  // The caller must explicitly supply a trusted test workspace in TMPDIR. Hermes
  // runs use its scratch directory; there is no fallback to the OS temp directory.
  // These checks do not defend against hostile ancestors, hard links or races.
  const configuredRoot=validateScratchPath(process.env.TMPDIR);
  let stat;
  try { stat=lstatSync(configuredRoot); }
  catch (error) { throw new Error(`TMPDIR must be an accessible existing directory: ${error.message}`, {cause:error}); }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'TMPDIR must be a real directory, not a symlink');
  const root=realpathSync(configuredRoot);
  const dir=mkdtempSync(join(root,'synthetic-upgrade-'));
  try {
    const db=new Database(join(dir,'fixture.sqlite'));
    try {
      db.exec(`CREATE TABLE legacy_cooldowns (kind TEXT NOT NULL, account_id TEXT NOT NULL, deadline INTEGER NOT NULL, PRIMARY KEY(kind,account_id));
CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
INSERT INTO legacy_cooldowns VALUES ('upstream','fixture',0);
INSERT INTO ordinary_account_attempts VALUES ('fixture','ordinary');
INSERT INTO siwc_account_attempts VALUES ('fixture','siwc');`);
      // This is a logical snapshot of these selected rows, schema and journal
      // mode only, not a byte-level comparison of the database or WAL.
      const snapshot=()=>({schema:db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
        legacy:db.prepare('SELECT * FROM legacy_cooldowns').all(), ordinary:db.prepare('SELECT * FROM ordinary_account_attempts').all(),
        siwc:db.prepare('SELECT * FROM siwc_account_attempts').all(), journal:db.pragma('journal_mode',{simple:true})});
      const before=snapshot();
      let accesses=0;
      const proxy=new Proxy(db,{get(target,key){
        accesses++;
        if(key==='name') return ':memory:';
        if(key==='pragma') return (name,...args)=>name==='database_list' ? [{seq:0,name:'main',file:''}] : target.pragma(name,...args);
        const value=target[key]; return typeof value==='function' ? value.bind(target) : value;
      }});
      assert.throws(()=>convertSynthetic429(proxy,{backupVerified:true,allRoutersStoppedAndFenced:true}));
      assert.equal(accesses,0);
      assert.deepEqual(snapshot(),before);
      assert.throws(()=>convertSynthetic429(proxy), /Expected a JSON fixture string/);
      assert.equal(accesses,0);
      assert.deepEqual(snapshot(),before);
    } finally {db.close();}
    const verify=new Database(join(dir,'fixture.sqlite'),{readonly:true,fileMustExist:true});
    try {assert.equal(verify.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'experimental_atomic_429_%'").get().n,0);}
    finally {verify.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
