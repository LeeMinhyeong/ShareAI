import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
const dir = mkdtempSync(join(process.env.TMPDIR, 'siwc-http-'));
const file = join(dir,'db.sqlite');
process.env.DATABASE_URL = `sqlite:${file}`;
process.env.ENCRYPTION_KEY = '0'.repeat(64); process.env.ADMIN_API_KEY = 'x'.repeat(20);
const {getDb, closeDatabase} = await import('../src/db/client.ts');
const {hashApiKey, CredentialVault} = await import('../src/utils/encryption.ts');
const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
const {default: router} = await import('../src/routes/v1.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db = getDb();
db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('a','a'); INSERT INTO siwc_access_policy VALUES ('a',1,'all')");
db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit) VALUES ('u',?,'u','u@example.invalid','free',100)").run(hashApiKey('synthetic-key'));
new SiwcStore(db,new CredentialVault()).create('a',{issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'old',refreshToken:'old-refresh',idToken:'id',tokenType:'Bearer',expiresIn:1,scopes:['offline_access','chatgpt.tokens.use.direct'],savedAt:'2020-01-01T00:00:00.000Z'});
const app = express(); app.use(express.json()); app.use('/v1',router); const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
test('real authenticated chat request does not block the event loop on an independently held write lock', {timeout:5000}, async () => {
  const child=fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
  const originalFetch=globalThis.fetch; let providerCalls=0;
  globalThis.fetch=async () => { providerCalls++; throw new Error('unexpected synthetic provider call'); };
  try {
    await once(child,'message');
    const start=Date.now(); let tick;
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer synthetic-key','content-type':'application/json'}},res=>res.resume());
    req.on('error',()=>{}); req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}));
    await new Promise(resolve=>setTimeout(()=>{tick=Date.now()-start; req.destroy(); resolve();},100));
    assert.ok(tick < 300,`event loop blocked ${tick}ms while SQLite writer held lock`);
    assert.equal(providerCalls,0);
  } finally { if (child.exitCode===null && child.signalCode===null) { child.kill(); await once(child,'exit'); } await new Promise(r=>setTimeout(r,100)); globalThis.fetch=originalFetch; }
  assert.equal(db.prepare("SELECT COALESCE(SUM(used),0) AS used FROM user_daily_quota WHERE user_id='u'").get().used,0,'cancelled request reserved quota after disconnect');
  assert.equal(providerCalls,0,'cancelled request invoked provider');
});
test('a request waiting on a process lock reserves quota exactly once', {timeout:5000}, async () => {
  const child=fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
  try {
    await once(child,'message');
    const response = await new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer synthetic-key','content-type':'application/json'}},res=>{res.resume(); res.on('end',()=>resolve(res.statusCode));});
      req.on('error',reject); req.end(JSON.stringify({model:'invalid',messages:[]}));
    });
    assert.equal(response,400);
    assert.equal(db.prepare("SELECT SUM(used) AS used FROM user_daily_quota WHERE user_id='u'").get().used,1);
  } finally {if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}}
});
test.after(async () => { await new Promise(r=>server.close(r)); closeDatabase(); rmSync(dir,{recursive:true,force:true}); });
