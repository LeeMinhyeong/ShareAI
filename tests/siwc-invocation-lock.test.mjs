import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const scratch = join(homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
mkdirSync(scratch, {recursive:true});
const dir = mkdtempSync(join(scratch, 'siwc-lock-'));
const file = join(dir, 'db.sqlite');
process.env.DATABASE_URL = `sqlite:${file}`;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);
const { getDb, closeDatabase } = await import('../src/db/client.ts');
const { CredentialVault } = await import('../src/utils/encryption.ts');
const { SiwcStore } = await import('../src/upstream/siwc-store.ts');
const { forwardChat } = await import('../src/upstream/forward-chat.ts');
const worker = fileURLToPath(new URL('./siwc-invocation-lock-worker.mjs', import.meta.url));
const args = mode => ['--import', import.meta.resolve('tsx'), worker, file, mode];
const run = mode => spawnSync(process.execPath, args(mode), {env:process.env, timeout:10000, stdio:'pipe'});
const req = () => ({user:{id:'u'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}});
const res = () => Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,statusCode:200,status(n){this.statusCode=n;return this},json(){this.writableEnded=true;return this},getHeader(){},setHeader(){},end(){this.writableEnded=true}});
const credential = () => ({issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'synthetic',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db = getDb();
db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('a','a'); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('u','h','u','u@example.invalid','free'); INSERT INTO siwc_access_policy VALUES ('a',1,'all');");
const store = new SiwcStore(db,new CredentialVault());
store.create('a',credential());

test('changed credential or revoked access after snapshot prevents invocation', async () => {
  const oldRead = SiwcStore.prototype.readSnapshot, oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected fetch'); };
  const mutations = [
    () => store.replace('a', {...credential(), accessToken:'replacement'}),
    () => db.prepare("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='a'").run(),
    () => db.prepare("UPDATE users SET enabled=0 WHERE id='u'").run(),
    () => db.prepare("DELETE FROM siwc_credentials WHERE id='a'").run(),
  ];
  try {
    for (const mutate of mutations) {
      let changed = false;
      SiwcStore.prototype.readSnapshot = function(id) {
        const snapshot = oldRead.call(this,id);
        if (!changed && snapshot) { changed = true; mutate(); }
        return snapshot;
      };
      const response = res(); await forwardChat(req(),response);
      assert.equal(changed,true);
      assert.notEqual(response.statusCode,200);
      assert.equal(calls,0);
      SiwcStore.prototype.readSnapshot = oldRead;
      db.exec("UPDATE siwc_access_policy SET enabled=1 WHERE account_id='a'; UPDATE users SET enabled=1 WHERE id='u'");
      if (!store.read('a')) store.create('a',credential());
    }
  } finally { SiwcStore.prototype.readSnapshot = oldRead; globalThis.fetch = oldFetch; }
});

test('revocation after OPEN commit clears the undispatched owned marker', async () => {
  const oldExec = Database.prototype.exec, oldFetch = globalThis.fetch;
  let revoked = false, calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('unexpected fetch'); };
  Database.prototype.exec = function(sql) {
    const result = oldExec.call(this, sql);
    if (sql === 'COMMIT' && !revoked && this.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get()) {
      revoked = true;
      const child = spawnSync(process.execPath, ['-e', "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare(\"UPDATE siwc_access_policy SET enabled=0 WHERE account_id='a'\").run();d.close()", file], {timeout:5000,encoding:'utf8'});
      assert.equal(child.status, 0, child.stderr);
    }
    return result;
  };
  try {
    const response = res(); await forwardChat(req(), response);
    assert.equal(revoked, true); assert.equal(calls, 0); assert.equal(response.statusCode, 404);
    assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get(), undefined);
  } finally { Database.prototype.exec = oldExec; globalThis.fetch = oldFetch; db.exec("UPDATE siwc_access_policy SET enabled=1 WHERE account_id='a'"); }
});

test('prestart cancellation, credential drift and writer failure release only the owned OPEN', async () => {
  const oldExec=Database.prototype.exec, oldFetch=globalThis.fetch;
  let calls=0; globalThis.fetch=()=>{calls++;throw new Error('unexpected fetch');};
  try {
    for (const mode of ['cancel','credential','writer']) {
      const response=res(); let admitted=false, injected=false;
      Database.prototype.exec=function(sql) {
        if (mode==='writer' && admitted && !injected && sql==='BEGIN IMMEDIATE') { injected=true; throw new Error('writer failure'); }
        const value=oldExec.call(this,sql);
        if (sql==='COMMIT' && !admitted && this.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get()) {
          admitted=true;
          if(mode==='cancel') response.emit('close');
          if(mode==='credential') store.replace('a',{...credential(),accessToken:'changed'});
        }
        return value;
      };
      await forwardChat(req(),response);
      assert.equal(admitted,true,mode); assert.equal(calls,0,mode);
      assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get(),undefined,mode);
      Database.prototype.exec=oldExec; store.replace('a',credential());
    }
  } finally {Database.prototype.exec=oldExec;globalThis.fetch=oldFetch;}
});

test('failed prestart cleanup leaves OPEN and never invokes fetch', async () => {
  const oldExec=Database.prototype.exec, oldFetch=globalThis.fetch; let admitted=false, calls=0;
  globalThis.fetch=()=>{calls++;throw new Error('unexpected fetch');};
  Database.prototype.exec=function(sql) {
    if(admitted && sql==='BEGIN IMMEDIATE') throw new Error('writer unavailable');
    const value=oldExec.call(this,sql);
    if(sql==='COMMIT' && !admitted && this.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get()) admitted=true;
    return value;
  };
  try { const response=res(); await forwardChat(req(),response); assert.equal(admitted,true);assert.equal(calls,0);assert.ok(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get()); }
  finally {Database.prototype.exec=oldExec;globalThis.fetch=oldFetch;db.prepare("DELETE FROM siwc_account_attempts WHERE account_id='a'").run();}
});

test('synchronous start failure keeps OPEN', async () => {
  const oldFetch=globalThis.fetch; let calls=0;
  globalThis.fetch=()=>{calls++;throw new Error('synchronous fetch failure');};
  try {const response=res();await forwardChat(req(),response);assert.equal(calls,1);assert.ok(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get());}
  // The transport failure arms this process's revision-keyed local SIWC backoff; a new credential
  // revision isolates the next case from it.
  finally {globalThis.fetch=oldFetch;db.prepare("DELETE FROM siwc_account_attempts WHERE account_id='a'").run();store.replace('a',credential());}
});

test('fetch invocation holds write lock; pending network does not block logout', async () => {
  const oldFetch = globalThis.fetch;
  let resolve, calls = 0, entered;
  const invocation = new Promise(r => { entered = r; });
  globalThis.fetch = () => {
    calls++;
    const probe = run('probe');
    assert.equal(probe.status, 0, 'another process acquired write lock during fetch invocation');
    return new Promise(r => { resolve = r; entered(); });
  };
  try {
    const response = res();
    const pending = forwardChat(req(),response);
    await Promise.race([invocation, pending.then(() => { throw new Error('request ended before fetch'); }), new Promise((_, reject) => { const t=setTimeout(() => reject(new Error('fetch barrier timeout')),10000); t.unref(); })]);
    assert.equal(calls,1);
    const logout = run('logout');
    assert.equal(logout.status,0,'logout could not acquire lock while fetch was pending');
    assert.equal(store.read('a'),null);
    resolve(new Response(responseStream,{headers:{'content-type':'text/event-stream'}}));
    await pending;
    assert.equal(response.statusCode,200);
  } finally { globalThis.fetch = oldFetch; }
});

test('process death releases an outstanding SQLite write lock', async () => {
  store.replace('a',credential());
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected fetch'); };
  const child = spawn(process.execPath,args('crash'),{env:process.env,stdio:['ignore','pipe','pipe']});
  try {
    const timer = setTimeout(() => child.kill(),10000); timer.unref();
    const [data] = await once(child.stdout,'data'); clearTimeout(timer);
    assert.equal(data.toString(),'locked\n');
    assert.equal(run('probe').status,0);
    db.pragma('busy_timeout = 150');
    const response = res(); await forwardChat(req(),response);
    assert.ok(response.statusCode >= 500);
    assert.equal(calls,0);
    child.kill();
    await once(child,'exit');
    const result = run('probe');
    assert.equal(result.status,2,'lock survived process exit');
    assert.equal(run('logout').status,0);
  } finally { db.pragma('busy_timeout = 5000'); globalThis.fetch = oldFetch; if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test.after(() => { closeDatabase(); rmSync(dir,{recursive:true,force:true}); });
