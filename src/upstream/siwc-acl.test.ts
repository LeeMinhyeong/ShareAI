import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.ADMIN_API_KEY = 'x'.repeat(20);
await (await import(new URL('../../tests/helpers/fresh-db.mjs', import.meta.url).href)).useFreshFileDatabase();
const { responseStream } = await import(new URL('../../tests/phase4-protocol-fixtures.mjs', import.meta.url).href); // complete lifecycle for the strict parser // test-only helper outside rootDir // the production client refuses an unprovisioned :memory: database
const { getDb } = await import('../db/client.js');
const { CredentialVault } = await import('../utils/encryption.js');
const { SiwcStore } = await import('./siwc-store.js');
const { forwardChat } = await import('./forward-chat.js');
const { createSiwcRouter } = await import('./siwc-login.js');

test('private legacy SIWC account denies explicit selection without upstream access', async () => {
  const db = getDb();
  db.exec('CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.prepare('INSERT INTO siwc_accounts VALUES (?, ?)').run('private', 'private');
  new SiwcStore(db, new CredentialVault()).create('private', {issuer:'https://auth.openai.com',subject:'synthetic',clientId:'synthetic',accessToken:'synthetic',idToken:'synthetic',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(responseStream, {headers:{'content-type':'text/event-stream'}}); }) as typeof fetch;
  const app = express(); app.use(express.json()); app.post('/chat', (req, _res, next) => { req.user = {id:'ungranted'} as any; next(); }, forwardChat);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await original(`http://127.0.0.1:${(server.address() as any).port}/chat`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'private'}})});
    assert.equal(response.status, 404); assert.equal(calls, 0);
  } finally { globalThis.fetch = original; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('access revoked during refresh is rechecked before inference', async () => {
  const db = getDb();
  db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('race','race','race','race@example.invalid','free')").run();
  db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run('refresh','refresh');
  new SiwcStore(db,new CredentialVault()).create('refresh',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'refresh-client',accessToken:'old',refreshToken:'old-refresh',idToken:'id',tokenType:'Bearer',expiresIn:1,scopes:['chatgpt.tokens.use.direct','offline_access'],savedAt:'2020-01-01T00:00:00.000Z'});
  db.prepare("INSERT INTO siwc_access_policy VALUES ('refresh',1,'all')").run();
  const original = globalThis.fetch; let upstream = 0;
  globalThis.fetch = (async (url: any) => {
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      db.prepare("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='refresh'").run();
      return Response.json({access_token:'new',refresh_token:'new-refresh',token_type:'Bearer',expires_in:3600});
    }
    upstream++; return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const app = express(); app.use(express.json()); app.post('/chat',(req,_res,next)=>{req.user={id:'race'} as any;next()},forwardChat);
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const response = await original(`http://127.0.0.1:${(server.address() as any).port}/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'refresh'}})});
    assert.equal(response.status,404); assert.equal(upstream,0);
  } finally { globalThis.fetch=original; await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test('admin sharing policy controls explicit requests and disabled accounts', async () => {
  const db = getDb();
  for (const id of ['allowed', 'other']) db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier) VALUES (?,?,?,?, 'free')").run(id,id,id,id+'@example.invalid');
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(responseStream, {headers:{'content-type':'text/event-stream'}}); }) as typeof fetch;
  const app = express(); app.use(express.json());
  app.use('/siwc', createSiwcRouter((req, res, next) => req.get('authorization') === 'admin' ? next() : res.sendStatus(401)));
  app.post('/chat', (req, _res, next) => { req.user = {id:req.get('x-user')} as any; next(); }, forwardChat);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const policy = (body: object, admin = true) => original(base+'/siwc/accounts/private/access', {method:'POST',headers:{'content-type':'application/json', ...(admin ? {authorization:'admin'} : {})},body:JSON.stringify(body)});
  const chat = (id: string) => original(base+'/chat', {method:'POST',headers:{'content-type':'application/json','x-user':id},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'private'}})});
  try {
    assert.equal((await policy({enabled:true,scope:'all',userIds:[]}, false)).status,401);
    assert.equal((await policy({enabled:true,scope:'selected',userIds:['allowed']})).status,200);
    assert.equal((await chat('allowed')).status,200);
    assert.equal((await chat('other')).status,404);
    assert.equal((await policy({enabled:false,scope:'all',userIds:[]})).status,200);
    assert.equal((await chat('allowed')).status,404);
    assert.equal((await policy({enabled:true,scope:'all',userIds:[]})).status,200);
    assert.equal((await chat('other')).status,200);
    assert.equal((await policy({enabled:true,scope:'selected',userIds:['missing']})).status,400);
    assert.equal((await policy({enabled:true,scope:'selected',userIds:[]})).status,200);
    assert.equal((await chat('other')).status,404);
    assert.equal(calls,2);
  } finally { globalThis.fetch = original; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('logout immediately denies routing while revocation is pending without changing access policy', async () => {
  const db = getDb();
  db.prepare("INSERT INTO siwc_accounts VALUES ('logout-route','logout-route')").run();
  const store = new SiwcStore(db,new CredentialVault());
  store.create('logout-route',{issuer:'https://auth.openai.com',subject:'test',clientId:'logout-route',accessToken:'token',refreshToken:'refresh',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  db.prepare("INSERT INTO siwc_access_policy VALUES ('logout-route',1,'all')").run();
  const original = globalThis.fetch;
  let entered!: () => void, release!: () => void, upstream = 0;
  const started = new Promise<void>(r => { entered=r; });
  const gate = new Promise<void>(r => { release=r; });
  globalThis.fetch = (async (url: any) => {
    if (url.includes('openid-configuration')) { entered(); await gate; return Response.json({revocation_endpoint:'https://auth.openai.com/revoke'}); }
    if (url.includes('/revoke')) return new Response(null,{status:200});
    upstream++; throw new Error('unexpected inference');
  }) as typeof fetch;
  const app = express(); app.use(express.json());
  app.use('/siwc',createSiwcRouter((_req,_res,next)=>next()));
  app.post('/chat',(req,_res,next)=>{req.user={id:'allowed'} as any; next();},forwardChat);
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const logout=original(base+'/siwc/accounts/logout-route/logout',{method:'POST'});
    await started;
    const chat=await original(base+'/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'logout-route'}})});
    assert.equal(chat.status,503); assert.equal(upstream,0);
    assert.equal((db.prepare("SELECT enabled FROM siwc_access_policy WHERE account_id='logout-route'").get() as {enabled:number}).enabled,1);
    release(); assert.deepEqual(await (await logout).json(),{localSignedOut:true,remoteRevoked:true});
  } finally { release(); globalThis.fetch=original; await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
