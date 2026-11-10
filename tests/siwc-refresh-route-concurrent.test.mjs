import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {responseStream} from './phase4-protocol-fixtures.mjs';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const { getDb, closeDatabase } = await import('../src/db/client.ts');
const { CredentialVault } = await import('../src/utils/encryption.ts');
const { SiwcStore } = await import('../src/upstream/siwc-store.ts');
const { forwardChat } = await import('../src/upstream/forward-chat.ts');

test('aborting one waiting chat does not cancel another refresh consumer', async () => {
  const db = getDb();
  db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('a','a'); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('u','h','u','u@example.invalid','free'); INSERT INTO siwc_access_policy VALUES ('a',1,'all');");
  new SiwcStore(db,new CredentialVault()).create('a',{issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'old',refreshToken:'old-refresh',idToken:'id',tokenType:'Bearer',expiresIn:1,scopes:['offline_access','chatgpt.tokens.use.direct'],savedAt:'2020-01-01T00:00:00.000Z'});
  const original = globalThis.fetch;
  let release, started; const gate = new Promise(r => release = r), sent = new Promise(r => started = r);
  let refreshes=0, inferences=0;
  globalThis.fetch = async (url,init) => {
    if (url.includes('/oauth/token')) { refreshes++; started(); await gate; return Response.json({access_token:'rotated',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600}); }
    inferences++; assert.equal(init.headers.authorization,'Bearer rotated');
    return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});
  };
  const req = () => ({user:{id:'u'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}});
  const res = () => Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,statusCode:200,status(n){this.statusCode=n;return this},json(){this.writableEnded=true;return this},getHeader(){},setHeader(){},end(){this.writableEnded=true}});
  try {
    const a=res(), b=res(); const p=forwardChat(req(),a); await sent; const q=forwardChat(req(),b);
    b.emit('close');
    const finished = await Promise.race([q.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]);
    assert.equal(finished,true,'aborted waiter should stop waiting');
    release(); await Promise.all([p,q]);
    assert.equal(refreshes,1); assert.equal(inferences,1); assert.equal(a.statusCode,200);
  } finally { release(); globalThis.fetch=original; closeDatabase(); }
});
