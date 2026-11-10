import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {create429Fixture, bounded429} from './phase4-429-owned-fixture.mjs';
import {listenFixture} from './siwc-local-only-listen.mjs';
import {closeFixtureServer} from './siwc-local-only-cleanup.mjs';

// Start the TS transformer before the fixture chdir so its Windows child cannot hold the fixture directory open.
await import('../src/protocol/types.ts');

let fixture, closeDatabase, repo, db, server, handling, ordinary429Deadline;
let listenPending, importStarted = false;
const originalFetch = globalThis.fetch;
const blockedFetch=async()=>{throw new Error('unexpected upstream fetch');};
const activeHandlers=new Set();
let shuttingDown=false;
globalThis.fetch=blockedFetch;
// Register cleanup before any fixture, application import, database or listener setup.
after(async()=>{
  shuttingDown=true;
  globalThis.fetch=blockedFetch;
  const errors=[];
  let safe=true;
  if(listenPending) try { await bounded429(listenPending,'listen completion'); } catch(e) { errors.push(e); safe=false; }
  if(server) try { await bounded429(closeFixtureServer(server),'server close'); } catch(e) { errors.push(e); safe=false; }
  if(activeHandlers.size) try { await bounded429(Promise.allSettled([...activeHandlers]),'handler completion'); } catch(e) { errors.push(e); safe=false; }
  if(safe) globalThis.fetch=originalFetch;
  if(closeDatabase && safe) try { closeDatabase(); } catch(e) { errors.push(e); safe=false; }
  else if(importStarted && !closeDatabase) safe=false;
  if(fixture) try { fixture.cleanup(safe); } catch(e) { errors.push(e); }
  if(errors.length) throw new AggregateError(errors,'429 HTTP cleanup failed');
});
before(async()=>{
  fixture=create429Fixture(); fixture.enter();
  importStarted=true;
  await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
  const client=await import('../src/db/client.ts'); closeDatabase=client.closeDatabase;
  const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
  const {UserRepository}=await import('../src/db/repositories/users.ts');
  const {hashApiKey}=await import('../src/utils/encryption.ts');
  const {authenticateUser}=await import('../src/auth/user-auth.ts');
  const forward=await import('../src/upstream/forward-chat.ts'); ordinary429Deadline=forward.ordinary429Deadline;
  repo=new AccountRepository(); db=client.getDb();
  new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'test',email:'test@example.invalid',tier:'pro',dailyLimit:100});
  const app=express(); app.use(express.json()); app.post('/v1/chat/completions',authenticateUser,(req,res)=>{
    if(shuttingDown) { if(!res.destroyed) res.end(); return; }
    const currentHandler=handling=forward.forwardChat(req,res);
    activeHandlers.add(currentHandler);
    currentHandler.then(()=>activeHandlers.delete(currentHandler),()=>activeHandlers.delete(currentHandler));
  });
  server=http.createServer(app);
  listenPending=listenFixture(server);
  await bounded429(listenPending,'server listen');
});
function request(withHeaders=false){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>resolve(withHeaders ? {status:res.statusCode,headers:res.headers,body} : res.statusCode));});req.on('error',reject);req.setTimeout(6000,()=>req.destroy(new Error('request timed out')));req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}}));});}
test('invalid and excessive retry hints never shorten the restriction',()=>{
 const now=Date.parse('2026-01-02T03:04:05Z');
 for (const hint of ['999999999999999999999999999999','9007199254740991','-1','1.5','120, 10','Thu, 02 Jan 2026 03:06:05 GMT','Fri, 32 Jan 2026 03:06:05 GMT','2026-01-02T03:06:05Z']) assert.equal(ordinary429Deadline(now,hint),Number.MAX_SAFE_INTEGER,hint);
 assert.equal(ordinary429Deadline(now,'0'),now+5000);
 assert.equal(ordinary429Deadline(now,undefined),now+5000);
});

test('legacy HTTP dates and upstream clock skew are handled conservatively',()=>{
 const now=Date.parse('2026-01-02T03:04:05Z');
 assert.equal(ordinary429Deadline(now,'Friday, 02-Jan-26 03:06:05 GMT'),now+120000);
 assert.equal(ordinary429Deadline(now,'Fri Jan  2 03:06:05 2026'),now+120000);
 assert.equal(ordinary429Deadline(now,'Fri, 02 Jan 2026 02:06:05 GMT','Fri, 02 Jan 2026 02:04:05 GMT'),now+121000);
 assert.equal(ordinary429Deadline(now,'Thursday, 02-Jan-26 03:06:05 GMT'),Number.MAX_SAFE_INTEGER);
});

test('a future provider Date cannot shorten a locally future Retry-After',()=>{
 const now=Date.parse('2026-01-02T03:04:05Z');
 assert.equal(ordinary429Deadline(now,'Fri, 02 Jan 2026 03:06:05 GMT','Sat, 02 Jan 2038 03:04:05 GMT'),now+120000);
 assert.equal(ordinary429Deadline(now,'Fri, 02 Jan 2026 03:06:05 GMT','Fri, 02 Jan 2026 03:05:05 GMT'),now+120000);
 assert.equal(ordinary429Deadline(now,'Fri, 02 Jan 2026 03:06:05 GMT','Fri, 02 Jan 2026 03:03:05 GMT'),now+181000);
});

test('RFC 850 two-digit years choose the future within 50 years across centuries',()=>{
 const now=Date.parse('2090-01-01T00:00:00Z');
 assert.equal(ordinary429Deadline(now,'Friday, 01-Jan-06 00:00:00 GMT'), Date.parse('2106-01-01T00:00:00Z'));
});

test('HTTP dates accept a valid leap second without accepting invalid calendar fields',()=>{
 const now=Date.parse('2016-12-31T23:59:00Z');
 assert.equal(ordinary429Deadline(now,'Sat, 31 Dec 2016 23:59:60 GMT'),now+60000);
 assert.equal(ordinary429Deadline(now,'Sun, 31 Dec 2016 23:59:60 GMT'),Number.MAX_SAFE_INTEGER);
});

// ADR 0008: a 429 arms a relative v2 restriction (monotonic expiry), not an
// absolute legacy cooldown. null means indefinite; the row must exist.
function restrictionMs(id){
 const row=db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(id);
 assert.ok(row,'v2 restriction armed');
 return row.duration_ms===null ? null : Number(row.duration_ms);
}
test('HTTP 429 forwards a safe delay and uses provider date for durable deadline', {timeout:10000}, async()=>{
 const clock=Date.now; const now=Date.parse('2026-01-02T03:04:05Z'); let a;
 try {
  Date.now=()=>now;
  a=repo.create({name:'header-hint',provider:'openai',credentialType:'api_key',credentials:'sk-header-hint',priority:0});
  globalThis.fetch=async()=>new Response('limited',{status:429,headers:{'retry-after':'Fri, 02 Jan 2026 02:06:05 GMT','date':'Fri, 02 Jan 2026 02:04:05 GMT'}});
  const result=await request(true); await handling;
  assert.equal(result.status,429); assert.equal(result.headers['retry-after'],'121');
  assert.deepEqual(db.prepare('SELECT success,error FROM usage_logs WHERE upstream_account_id=?').all(a.id),[{success:0,error:null}]);
  assert.ok(restrictionMs(a.id)>=121000);
 } finally {try {if(a) repo.update(a.id,{status:'disabled'});} finally {Date.now=clock;globalThis.fetch=blockedFetch;}}
});

test('429 hints restrict only the first ordinary account without fabricating response headers', {timeout:10000},async()=>{
 const clock=Date.now, now=Date.parse('2026-01-02T03:04:05Z'); Date.now=()=>now;
 const cases=[
  {name:'future-date',hint:'Fri, 02 Jan 2026 03:06:05 GMT',date:'Sat, 02 Jan 2038 03:04:05 GMT',deadline:now+120000,header:'120'},
  {name:'malformed',hint:'not a date',deadline:Number.MAX_SAFE_INTEGER},
  {name:'huge',hint:'999999999999999999999999999999',deadline:Number.MAX_SAFE_INTEGER},
 ];
 try {
  for(const c of cases) {
   const a=repo.create({name:`${c.name}-a`,provider:'openai',credentialType:'api_key',credentials:`sk-${c.name}-a`,priority:0});
   const b=repo.create({name:`${c.name}-b`,provider:'openai',credentialType:'api_key',credentials:`sk-${c.name}-b`,priority:10});
   const calls=[];
   try {
    globalThis.fetch=async (_url,opts)=>{calls.push(opts.headers.authorization);return new Response('limited',{status:429,headers:{'retry-after':c.hint,...(c.date?{date:c.date}:{})}});};
    const result=await request(true);await handling;
    assert.equal(result.status,429,c.name);
    assert.deepEqual(calls,[`Bearer sk-${c.name}-a`],c.name);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_daily_reservations WHERE account_id=?').get(b.id).n,0,c.name);
    assert.equal(restrictionMs(a.id),c.deadline===Number.MAX_SAFE_INTEGER ? null : c.deadline-now,c.name);
    assert.equal(result.headers['retry-after'],c.header,c.name);
    assert.ok(!JSON.stringify(result).includes(String(Number.MAX_SAFE_INTEGER)),c.name);
   } finally {repo.update(a.id,{status:'disabled'});repo.update(b.id,{status:'disabled'});}
  }
 } finally {Date.now=clock;globalThis.fetch=blockedFetch;}
});

test('ordinary upstream 429 honors Retry-After seconds; an unanchored HTTP date stays indefinite', {timeout:10000},async()=>{
 const clock=Date.now; const now=Date.parse('2026-01-02T03:04:05Z');Date.now=()=>now;
 try {
  // An absolute hint without a valid provider Date cannot be anchored, so it stays indefinite (null).
  for(const [i,hint,deadline] of [[0,'120',now+120000],[1,'Fri, 02 Jan 2026 03:06:05 GMT',null]]) {
   const a=repo.create({name:`hint-${i}`,provider:'openai',credentialType:'api_key',credentials:`sk-hint-${i}`,priority:0});
   globalThis.fetch=async()=>new Response('limited',{status:429,headers:{'retry-after':hint}});
   assert.equal(await request(),429);await handling;
   const ms=restrictionMs(a.id);
   if (deadline===null) assert.equal(ms,null,hint);
   else assert.ok(ms!==null && ms>=deadline-now,`${hint}: ${ms} < ${deadline-now}`);
   repo.update(a.id,{status:'disabled'});
  }
 } finally {Date.now=clock;globalThis.fetch=blockedFetch;}
});
