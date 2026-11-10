import {test, beforeEach, afterEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {chatStream, responseStream} from './phase4-protocol-fixtures.mjs';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'least-utc-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // what db:init does (ADR 0018)
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const v1=(await import('../src/routes/v1.ts')).default;
const db=getDb(), repo=new AccountRepository();
db.prepare('INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit) VALUES (?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
const account=repo.create({name:'ordinary',provider:'openai',credentialType:'api_key',credentials:'sk-fixture',priority:0});
db.exec('CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run(account.id,'siwc');
db.prepare('INSERT INTO siwc_access_policy VALUES (?,1,?)').run(account.id,'all');
db.prepare('INSERT INTO siwc_routing_settings (account_id,priority,weight) VALUES (?,1,1)').run(account.id);
new SiwcStore(db,new CredentialVault()).create(account.id,{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'fixture',accessToken:'synthetic-access',idToken:'synthetic-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
db.prepare('UPDATE upstream_accounts SET used_today=50 WHERE id=?').run(account.id);
// Each HTTP case owns its listener, client requests, handler promises and sockets.
const route=v1.stack.find(layer=>layer.route?.path==='/chat/completions').route;
const handlerLayer=route.stack[route.stack.length-1], originalHandler=handlerLayer.handle;
const originalFetch=globalThis.fetch, calls=[];
const logCount=table=>db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('u').n;
async function bounded(promise,label,ms=4000) {
 let timer;
 try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),ms);})]);}
 finally {clearTimeout(timer);}
}
async function waitForLog(table,previous) {const until=Date.now()+4000;while(logCount(table)<=previous){if(Date.now()>=until)throw new Error(`Timed out waiting for ${table} persistence`);await new Promise(r=>setTimeout(r,10));}}
let fixture, poisoned;
// Never unwind test finally blocks while an owned handler might still mutate state.
// This worker is disposable; the parent waits for its close before deleting files.
function poisonAndExit(err) { poisoned=err; console.error('Unsettled HTTP fixture; terminating isolated worker'); process.exit(1); }
async function createFixture() {
 const sockets=new Set(), handlers=new Set(), requests=new Set(), controllers=new Set(), operations=new Set();
 const previousFetch=globalThis.fetch;
 let handling, server, closePromise, markHungStarted;
 const hungStarted=new Promise(resolve=>{markHungStarted=resolve;});
 const track=promise=>{
  const observed=Promise.resolve(promise);
  handlers.add(observed);
  observed.then(()=>handlers.delete(observed),()=>handlers.delete(observed));
  return observed;
 };
 const destroySockets=()=>{for(const socket of sockets) socket.destroy();};
 const settle=async()=>{
  // New completions can be registered while sockets are closing.
  while(requests.size || handlers.size) await bounded(Promise.allSettled([...requests,...handlers]),'request/handler settlement');
 };
 const cleanup=async()=>{
  const errors=[];
  try {
  for(const controller of controllers) controller.abort();
  if(server) {
   closePromise=new Promise((resolve,reject)=>server.close(err=>err ? reject(err) : resolve()));
   destroySockets();
  }
  try {await settle();await bounded(Promise.allSettled([...operations]),'request operations');} catch(err) {poisonAndExit(err);}
  if(closePromise) {
   try {await bounded(closePromise,'server close');}
   catch(err) {destroySockets();try {await bounded(closePromise,'forced server close');} catch(closeErr) {poisonAndExit(closeErr);}}
  }
  try {await bounded(Promise.all([...sockets].map(socket=>once(socket,'close'))),'socket closure');}
  catch(err) {poisonAndExit(err);}
  if(errors.length) throw new AggregateError(errors,'HTTP fixture cleanup failed');
  } finally {
   handlerLayer.handle=originalHandler;
   globalThis.fetch=previousFetch;
  }
 };
 try {
  handlerLayer.handle=(req,res,next)=>{handling=track(originalHandler(req,res,next));return handling;};
  const app=express();app.use(express.json());app.use('/v1',v1);
  app.post('/chat',authenticateUser,(req,res,next)=>{handling=track(forwardChat(req,res));handling.catch(next);});
  // Synthetic hung handler settles only after the test-owned response is closed.
  app.post('/hung',(req,res)=>{handling=track(process.env.FIXTURE_UNCOOPERATIVE==='1' ? new Promise(()=>{}) : new Promise(resolve=>res.once('close',resolve)));markHungStarted();});
  server=http.createServer(app);
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');
  await bounded(once(server,'listening'),'server startup');
  assert.notEqual(server.address().port,20128);
  return {sockets,handlers,requests,operations,cleanup,hungStarted,request(...args) {
   const operation=runRequest(...args);operations.add(operation);
   operation.then(()=>operations.delete(operation),()=>operations.delete(operation));
   return operation;
  }};
  async function runRequest(pathname,key,strategy,expectedLog,timeout=4000) {
   const previous=expectedLog ? logCount(expectedLog) : 0;handling=undefined;
   const controller=new AbortController();controllers.add(controller);
   const pending=new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:pathname,method:'POST',signal:controller.signal,headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{res.resume();res.on('error',reject);res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy}}));
   });
   requests.add(pending);pending.then(()=>requests.delete(pending),()=>requests.delete(pending));
   try {
    const response=await bounded(pending,'HTTP response',timeout);
    if(expectedLog) await waitForLog(expectedLog,previous);
    if(key==='fixture-key') {assert.ok(handling,'authenticated handler was invoked');await bounded(handling,'handler completion');}
    return response;
   } catch(err) {
    controller.abort();destroySockets();
    try {await settle();} catch(cleanupErr) {poisonAndExit(cleanupErr);}
    throw err;
   } finally {controllers.delete(controller);}
  }
 } catch(err) {
  try {await cleanup();} catch(cleanupErr) {throw new AggregateError([err,cleanupErr],'fixture startup and cleanup failed');}
  throw err;
 }
}
async function request(...args) {fixture ??= await createFixture();return fixture.request(...args);}
const send=(key='fixture-key',expectedLog)=>request('/chat',key,'least_used',expectedLog);
beforeEach(()=>{if(poisoned) throw new Error('Previous HTTP fixture did not settle',{cause:poisoned});db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');calls.length=0;db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);db.prepare('UPDATE siwc_routing_settings SET priority=1 WHERE account_id=?').run(account.id);db.prepare('UPDATE upstream_accounts SET used_today=50,priority=0 WHERE id=?').run(account.id);globalThis.fetch=async (_url,opts)=>{const token=opts.headers.authorization;calls.push(token);return new Response(token==='Bearer synthetic-access'?responseStream:chatStream,{headers:{'content-type':'text/event-stream'}});};});
afterEach(async()=>{try {if(fixture){const owned=fixture;fixture=undefined;await owned.cleanup();}} finally {globalThis.fetch=originalFetch;}});
after(()=>{globalThis.fetch=originalFetch;handlerLayer.handle=originalHandler;if(!poisoned){closeDatabase();rmSync(dir,{recursive:true,force:true});}});
test('HTTP fixture settles timeout and assertion failures and restores instrumentation',{timeout:15000},async()=>{
 for(const failure of ['timeout','assertion']) {
  const previousFetch=globalThis.fetch, owned=await createFixture();
  const exercise=async()=>{
   try {
    const pending=owned.request('/hung','invalid','priority',undefined,failure==='timeout'?500:4000);
    const settled=pending.then(()=>null,err=>err);
    await bounded(owned.hungStarted,'hung handler started');
    if(failure==='timeout') {
     const outcome=await settled;assert.match(outcome.message,/Timed out: HTTP response/);
    } else assert.fail('intentional fixture assertion');
   } finally {await owned.cleanup();}
  };
  if(failure==='assertion') await assert.rejects(exercise,/intentional fixture assertion/);
  else await exercise();
  assert.equal(owned.requests.size,0);assert.equal(owned.operations.size,0);assert.equal(owned.handlers.size,0);assert.equal(owned.sockets.size,0);
  assert.equal(handlerLayer.handle,originalHandler);assert.equal(globalThis.fetch,previousFetch);
 }
 assert.equal(await request('/v1/chat/completions','fixture-key','priority','usage_logs'),200);
});
test('mixed priority breaks ties using UTC successes rather than stale ordinary counter',async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 db.prepare('UPDATE upstream_accounts SET used_today=2 WHERE id=?').run(account.id);
 db.prepare('UPDATE siwc_routing_settings SET priority=0 WHERE account_id=?').run(account.id);
 const u=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,0,0,1,0)');
 const s=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES(?,?,?,?,?,?,1,0,200,0)');
 try {
  u.run('yesterday-1','u',account.id,'2029-12-31T10:00:00.000Z','gpt-5','openai');
  u.run('yesterday-2','u',account.id,'2029-12-31T11:00:00.000Z','gpt-5','openai');
  s.run('today','u',account.id,'2030-01-01T01:00:00.000Z','gpt-5','openai');
  const result=await new AccountPoolManager(()=>Date.parse('2030-01-01T02:00:00.000Z')).selectCandidate('u','gpt-5','openai','priority');
  assert.equal(result.kind,'upstream');assert.equal(result.usedToday,0);
 } finally {db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');db.prepare('UPDATE siwc_routing_settings SET priority=1 WHERE account_id=?').run(account.id);db.prepare('UPDATE upstream_accounts SET used_today=50 WHERE id=?').run(account.id);}
});
test('mixed priority uses per-kind UTC valid successes, one as-of, then deterministic kind key',async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 db.prepare('UPDATE siwc_routing_settings SET priority=0 WHERE account_id=?').run(account.id);
 db.prepare('UPDATE upstream_accounts SET used_today=0 WHERE id=?').run(account.id);
 const u=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,0,0,?,0)');
 const s=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES(?,?,?,?,?,?,?,?,200,0)');
 const addU=(id,t,success=1)=>u.run(id,'u',account.id,t,'gpt-5','openai',success);
 const addS=(id,t,success=1,aborted=0)=>s.run(id,'u',account.id,t,'gpt-5','openai',success,aborted);
 const asOf=Date.parse('2030-01-01T00:30:00.000Z');let captures=0;
 const pool=new AccountPoolManager(()=>{captures++;return asOf;});
 const pick=async()=>{captures=0;const result=await pool.selectCandidate('u','gpt-5','openai','priority');assert.equal(captures,1);return result;};
 try {
  // Yesterday is locally today in Asia/Seoul; malformed values lie inside SQL ranges.
  addU('previous','2029-12-31T23:59:59.999Z');addU('valid','2030-01-01 00:00:00');
  addU('invalid','2030-01-01T00:15:99.000Z');addU('future','2030-01-01T00:31:00.000Z');addU('failure','2030-01-01T00:20:00.000Z',0);
  let result=await pick();assert.equal(result.kind,'siwc');assert.equal(result.usedToday,0);
  addS('valid-s','2030-01-01T00:20:00.000Z');addS('failed-s','2030-01-01T00:21:00.000Z',0);addS('aborted-s','2030-01-01T00:22:00.000Z',1,1);
  addS('malformed-s','2030-01-01T00:12:99.000Z');addS('future-s','2030-01-01T00:31:00.000Z');
  result=await pick();assert.equal(result.kind,'siwc');assert.equal(result.usedToday,1); // same ID, equal counts: siwc sorts first
  addS('second-s','2030-01-01 00:25:00');result=await pick();assert.equal(result.kind,'upstream');assert.equal(result.usedToday,1);
  db.prepare('UPDATE upstream_accounts SET priority=1 WHERE id=?').run(account.id);
  result=await pick();assert.equal(result.kind,'siwc');assert.equal(result.usedToday,2);
 } finally {db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');db.prepare('UPDATE siwc_routing_settings SET priority=1 WHERE account_id=?').run(account.id);db.prepare('UPDATE upstream_accounts SET used_today=50,priority=0 WHERE id=?').run(account.id);}
});
test('UTC ranking avoids redundant local-midnight SIWC counts while round robin preserves its count',async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 const now=new Date().toISOString();
 db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES(?,?,?,?,?,?,1,0,200,0)').run('rr-count','u',account.id,now,'gpt-5','openai');
 const prepare=db.prepare, queries=[];
 db.prepare=function(sql){queries.push(sql);return prepare.call(this,sql);};
 try {
  for (const strategy of ['priority','least_used']) {
   queries.length=0;
   const result=await new AccountPoolManager().selectCandidate('u','gpt-5','openai',strategy);
   assert.ok(result);assert.ok(!('timestamp' in result));
   assert.equal(queries.filter(q=>/SELECT COUNT\(\*\) FROM siwc_usage_logs/i.test(q)).length,0,`${strategy} redundant local count`);
   assert.equal(queries.filter(q=>/SELECT timestamp FROM siwc_usage_logs/i.test(q)).length,1);
  }
  queries.length=0;
  const pool=new AccountPoolManager();
  const first=await pool.selectCandidate('u','gpt-5','openai','round_robin');
  const second=await pool.selectCandidate('u','gpt-5','openai','round_robin');
  const siwc=[first,second].find(x=>x.kind==='siwc');
  assert.ok(siwc);assert.equal(siwc.usedToday,1);assert.ok(!('timestamp' in siwc));
  assert.equal(queries.filter(q=>/SELECT COUNT\(\*\) FROM siwc_usage_logs/i.test(q)).length,2);
 } finally {db.prepare=prepare;db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');}
});
test('UTC least-used ignores legacy counters and counts completed no-usage responses by kind', {timeout:10000},async()=>{
 assert.equal(await send('invalid'),401);assert.equal(calls.length,0);
 assert.equal(await send('fixture-key','usage_logs'),200);assert.deepEqual(calls,['Bearer sk-fixture']);
 assert.equal(await send('fixture-key','siwc_usage_logs'),200);assert.deepEqual(calls,['Bearer sk-fixture','Bearer synthetic-access']);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_logs WHERE upstream_account_id=? AND success=1').get(account.id).n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM siwc_usage_logs WHERE account_id=? AND success=1').get(account.id).n,1);
});
test('UTC midnight bounds exclude failures and future events without mixing colliding IDs', {timeout:10000},async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,0,0,1,0)').run('midnight-u','u',account.id,'2029-12-31T23:59:59.999Z','gpt-5','openai');
 db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES(?,?,?,?,?,?,1,0,200,0)').run('midnight-s','u',account.id,'2030-01-01T00:00:00.000Z','gpt-5','openai');
 db.prepare('INSERT INTO siwc_usage_logs (id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES (?,?,?,?,?,?,0,1,499,0)').run('failed','u',account.id,'2029-12-31T23:59:59.999Z','gpt-5','openai');
 let now=Date.parse('2029-12-31T23:59:59.999Z');const pool=new AccountPoolManager(()=>now);
 const pick=(strategy='least_used')=>pool.selectCandidate('u','gpt-5','openai',strategy,{credentialTypes:['api_key','oauth']});
 assert.equal((await pick()).kind,'siwc');
 now=Date.parse('2030-01-01T00:00:00.000Z');assert.equal((await pick()).kind,'upstream');
 assert.equal((await pick('priority')).kind,'upstream');
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 try {assert.equal((await pick()).kind,'upstream');} finally {db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
});
test('legacy and ISO timestamps count only completed successes through as-of, including ordinary-only result',async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 const insert=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,0,0,1,0)');
 for (const [id,t] of [['legacy','2030-01-01 01:00:00'],['iso','2030-01-01T02:00:00.000Z'],['future','2030-01-01T04:00:00.000Z'],['previous','2029-12-31 23:59:59'],['bad','bad']]) insert.run(id,'u',account.id,t,'gpt-5','openai');
 const pool=new AccountPoolManager(()=>Date.parse('2030-01-01T03:00:00Z'));
 assert.equal((await pool.selectCandidate('u','gpt-5','openai','least_used')).kind,'siwc');
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 try {const result=await pool.selectCandidate('u','gpt-5','openai','least_used');assert.equal(result.usedToday,2);} finally {db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
});
test('strict UTC history rejects normalized dates and sub-millisecond future values for both kinds',async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 const u=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,0,0,1,0)');
 const s=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES(?,?,?,?,?,?,1,0,200,0)');
 const values=['2030-02-28 00:00:00','2030-02-28T12:00:00.000Z','2030-02-28T12:00:00.0001Z','2030-02-30T01:00:00.000Z','2030-02-28T01:00:00Z','2030-02-28T01:00:00.000+00:00','2030-02-28T01:99:00.000Z','2030-02-28 01:99:00'];
 const {parseUsageUtc}=await import('../src/db/usage-utc.ts');
 assert.equal(parseUsageUtc('2030-02-30T01:00:00.000Z'),null);
 assert.equal(parseUsageUtc('2030-02-28T12:00:00.0001Z'),null);
 assert.equal(parseUsageUtc('2030-02-28 00:00:00'),Date.parse('2030-02-28T00:00:00.000Z'));
 assert.equal(parseUsageUtc('2030-02-28T12:00:00.000Z'),Date.parse('2030-02-28T12:00:00.000Z'));
 values.forEach((t,i)=>{u.run(`u${i}`,'u',account.id,t,'gpt-5','openai');s.run(`s${i}`,'u',account.id,t,'gpt-5','openai');});
 const pool=new AccountPoolManager(()=>Date.parse('2030-02-28T12:00:00.000Z'));
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 try {assert.equal((await pool.selectCandidate('u','gpt-5','openai','least_used')).usedToday,2);} finally {db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
 u.run('extra','u',account.id,'2030-02-28T11:59:59.999Z','gpt-5','openai');
 const result=await pool.selectCandidate('u','gpt-5','openai','least_used');
 assert.equal(result.kind,'siwc');assert.equal(result.usedToday,2);
 await assert.rejects(new AccountPoolManager(()=>NaN).selectCandidate('u','gpt-5','openai','least_used'),RangeError);
 db.prepare('DELETE FROM usage_logs').run();db.prepare('DELETE FROM siwc_usage_logs').run();
 u.run('impossible','u',account.id,'2030-02-30T01:00:00.000Z','gpt-5','openai');
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 try {assert.equal((await new AccountPoolManager(()=>Date.parse('2030-03-02T12:00:00.000Z')).selectCandidate('u','gpt-5','openai','least_used')).usedToday,0);} finally {db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
});
test('ordinary pre-dispatch account change and provider 422 do not create cooldown',async()=>{
 const {accountPool}=await import('../src/account-pool/manager.ts');
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 const oldSelect=accountPool.selectCandidate, oldFind=AccountRepository.prototype.findById, oldFetch=globalThis.fetch;
 let before, providerCalls=0, failLookup=false;
 try {
  AccountRepository.prototype.findById=function(...args){if(failLookup){failLookup=false;return null;}return oldFind.apply(this,args);};
  accountPool.selectCandidate=async (...args)=>{const selected=await oldSelect.apply(accountPool,args); before=db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(account.id); failLookup=true; return selected;};
  globalThis.fetch=async()=>{providerCalls++;return new Response('',{status:422});};
  assert.equal(await send(),502); assert.equal(providerCalls,0);
  assert.deepEqual(db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(account.id),before);
  assert.equal(accountPool.cooldownOf(account.id),0);
  accountPool.selectCandidate=oldSelect;
  db.prepare("UPDATE upstream_accounts SET status='active' WHERE id=?").run(account.id);
  assert.equal(await send('fixture-key','usage_logs'),422); assert.equal(providerCalls,1); assert.equal(accountPool.cooldownOf(account.id),0);
 } finally {accountPool.selectCandidate=oldSelect;AccountRepository.prototype.findById=oldFind;globalThis.fetch=oldFetch;db.prepare("UPDATE upstream_accounts SET status='active' WHERE id=?").run(account.id);db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
});
test('aborted before ordinary invocation does not mutate account state',async()=>{
 const {EventEmitter}=await import('node:events');
 const {accountPool}=await import('../src/account-pool/manager.ts');
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 const before=db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(account.id), previous=globalThis.fetch;
 let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected dispatch');};
 const res=new EventEmitter();Object.assign(res,{destroyed:true,writableEnded:false,headersSent:false,status(){return this;},json(){},getHeader(){},setHeader(){},end(){}});
 try {
  await forwardChat({user:{id:'u'},body:{model:'gpt-5',messages:[],router_options:{strategy:'priority'}}},res);
  assert.equal(calls,0);assert.deepEqual(db.prepare('SELECT * FROM upstream_accounts WHERE id=?').get(account.id),before);assert.equal(accountPool.cooldownOf(account.id),0);
 } finally {globalThis.fetch=previous;db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
});
test('authenticated production v1 route dispatches mixed priority winner',{timeout:10000},async()=>{
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 db.prepare('UPDATE upstream_accounts SET used_today=2 WHERE id=?').run(account.id);
 db.prepare('UPDATE siwc_routing_settings SET priority=0 WHERE account_id=?').run(account.id);
 db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,success,aborted,status,latency_ms) VALUES(?,?,?,?,?,?,1,0,200,0)').run('http-prior','u',account.id,new Date().toISOString(),'gpt-5','openai');
 const before=calls.length;
 const priorityRequest=(key,expectedLog)=>request('/v1/chat/completions',key,'priority',expectedLog);
 try {
  assert.equal(await priorityRequest('invalid'),401);assert.equal(calls.length,before);
  assert.equal(await priorityRequest('fixture-key','usage_logs'),200);assert.deepEqual(calls.slice(before),['Bearer sk-fixture']);
  assert.equal(await priorityRequest('fixture-key','siwc_usage_logs'),200);assert.deepEqual(calls.slice(before),['Bearer sk-fixture','Bearer synthetic-access']);
 }
 finally {db.prepare('UPDATE siwc_routing_settings SET priority=1 WHERE account_id=?').run(account.id);}
});
test('SQLite CURRENT_TIMESTAMP default is included for the current UTC day',async()=>{
 const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
 db.exec('DELETE FROM usage_logs; DELETE FROM siwc_usage_logs');
 db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,0,0,1,0)').run('default','u',account.id,'gpt-5','openai');
 db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('selected',account.id);
 try {assert.equal((await new AccountPoolManager().selectCandidate('u','gpt-5','openai','least_used')).usedToday,1);} finally {db.prepare('UPDATE siwc_access_policy SET scope=? WHERE account_id=?').run('all',account.id);}
});
