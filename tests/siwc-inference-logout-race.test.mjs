import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const scratch = join(homedir(),'AppData','Local','hermes','cache','scratch');
mkdirSync(scratch,{recursive:true});
const dir = mkdtempSync(join(scratch, 'siwc-inference-logout-'));
const file = join(dir, 'db.sqlite');
process.env.DATABASE_URL = `sqlite:${file}`;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);
const { getDb, closeDatabase } = await import('../src/db/client.ts');
const { CredentialVault } = await import('../src/utils/encryption.ts');
const { SiwcStore } = await import('../src/upstream/siwc-store.ts');
const { forwardChat } = await import('../src/upstream/forward-chat.ts');

test('logout in another process after snapshot prevents outbound inference', async () => {
  await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // production client never creates a database
  const db = getDb();
  db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('a','a'); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('u','h','u','u@example.invalid','free'); INSERT INTO siwc_access_policy VALUES ('a',1,'all');");
  const store = new SiwcStore(db,new CredentialVault());
  store.create('a',{issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'synthetic',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const oldRead = SiwcStore.prototype.readSnapshot;
  const oldFetch = globalThis.fetch;
  let barrier = false, calls = 0;
  SiwcStore.prototype.readSnapshot = function(id) {
    const snapshot = oldRead.call(this,id);
    if (!barrier && id === 'a' && snapshot) {
      barrier = true;
      const child = spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('./siwc-inference-logout-worker.mjs',import.meta.url)),file],{env:process.env,timeout:10000,stdio:'pipe'});
      assert.equal(child.status,0,`logout worker failed: ${child.stderr}`);
      assert.equal(store.read('a'),null);
    }
    return snapshot;
  };
  globalThis.fetch = async () => { calls++; return new Response('data: {"type":"response.completed","response":{}}\n\n',{headers:{'content-type':'text/event-stream'}}); };
  const req = {user:{id:'u'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}};
  const res = Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,statusCode:200,status(n){this.statusCode=n;return this},json(){this.writableEnded=true;return this},getHeader(){},setHeader(){},end(){this.writableEnded=true}});
  try {
    await forwardChat(req,res);
    assert.equal(barrier,true);
    assert.equal(calls,0,'fetch invoked after logout committed');
    assert.equal(res.statusCode,503);
    assert.equal(db.prepare("SELECT enabled FROM siwc_access_policy WHERE account_id='a'").get().enabled,1);
  } finally {
    SiwcStore.prototype.readSnapshot = oldRead; globalThis.fetch = oldFetch;
    closeDatabase(); rmSync(dir,{recursive:true,force:true});
  }
});
