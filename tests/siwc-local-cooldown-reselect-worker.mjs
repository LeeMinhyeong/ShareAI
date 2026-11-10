import assert from 'node:assert/strict';
import path from 'node:path';
import {lstatSync,readFileSync} from 'node:fs';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {responseStream} from './phase4-protocol-fixtures.mjs';
import {listenFixture} from './siwc-local-only-listen.mjs';
import {workerFailureDiagnostic} from './siwc-fixture-diagnostics.mjs';

const file=process.argv[2];
// Accidental-use boundary only: filesystem replacement and ancestor links remain races.
try {
 const root=process.env.SIWC_FIXTURE_ROOT, token=process.env.SIWC_FIXTURE_OWNER;
 if(!root || !path.isAbsolute(root) || !file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(token || '')) throw 0;
 const dir=path.dirname(file), marker=path.join(dir,'.siwc-fixture-owner');
 if(path.resolve(file)!==file || path.dirname(dir)!==path.resolve(root) || dir!==process.cwd() || !path.basename(dir).startsWith('siwc-local-race-') || path.basename(file)!=='fixture.sqlite') throw 0;
 if(!lstatSync(root).isDirectory() || !lstatSync(dir).isDirectory() || !lstatSync(marker).isFile() || readFileSync(marker,'utf8')!==token) throw 0;
 try {lstatSync(file);throw 0;} catch(e) {if(e?.code!=='ENOENT') throw e;}
} catch {
 console.error('SIWC fixture validation failed');
 process.exit(1);
}
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {accountPool}=await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this owned fixture file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(), users=new UserRepository();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','A'),('b','B'); INSERT INTO siwc_access_policy VALUES('a',1,'all'),('b',1,'all');");
const user=users.create({apiKeyHash:hashApiKey('fixture-key'),name:'u',email:'u@example.invalid',tier:'pro',dailyLimit:100});
const store=new SiwcStore(db,new CredentialVault());
for(const id of ['a','b']) store.create(id,{issuer:'https://auth.openai.com',subject:id,clientId:id,accessToken:`token-${id}`,idToken:'fixture-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
const bounded=(p,label)=>{let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timeout`)),10000);})]).finally(()=>clearTimeout(timer));};
let firstSelected,releaseFirst;const selected=new Promise(r=>firstSelected=r), release=new Promise(r=>releaseFirst=r);
const originalSelect=accountPool.selectCandidate.bind(accountPool), nativeFetch=globalThis.fetch;
const selections=[], calls=[], handlers=[];
const provider=http.createServer((req,res)=>{calls.push(req.headers.authorization);req.resume();if(['Bearer token-a','Bearer token-f'].includes(req.headers.authorization)){res.writeHead(429,{'retry-after':'30'});res.end('limited');}else{res.writeHead(200,{'content-type':'text/event-stream'});res.end(responseStream);}});
const app=express();app.use(express.json());app.post('/v1/chat/completions',authenticateUser,(req,res)=>{const p=forwardChat(req,res);handlers.push(p);});
let server;
function request(options){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,text}));res.on('error',reject);});const timer=setTimeout(()=>req.destroy(new Error('request timeout')),8000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:options}));});}
async function run(){
  await bounded(listenFixture(provider),'provider listen');
  server=http.createServer(app);await bounded(listenFixture(server),'app listen');
  globalThis.fetch=(url,opts)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');return nativeFetch(`http://127.0.0.1:${provider.address().port}/`,opts);};
  accountPool.selectCandidate=async(...args)=>{const candidate=await originalSelect(...args);selections.push(candidate?.id);if(selections.length===1){assert.equal(candidate?.id,'a');firstSelected();if(process.env.SIWC_FIXTURE_HANG==='1'){process.send?.('handler-active');await new Promise(()=>{});}await release;}return candidate;};
  const before=users.getTodayUsageCount(user.id);
  const pending=request({strategy:'priority'});await bounded(selected,'selection barrier');
  const competitor=await request({siwc_account_id:'a'});await bounded(handlers[1],'competitor completion');assert.equal(competitor.status,429);
  assert.ok(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='a'").get(),'the 429 armed a siwc v2 restriction'); // ADR 0008: v2 is the durable cooldown
  assert.equal(accountPool.siwcCooling('a',store.readSnapshot('a').revision),true);
  assert.equal(db.prepare("SELECT count(*) n FROM siwc_account_attempts WHERE account_id='a'").get().n,0);
  releaseFirst();const result=await pending;await bounded(handlers[0],'first completion');
  assert.equal(result.status,200,result.text);assert.deepEqual(selections,['a','b']);assert.deepEqual(calls,['Bearer token-a','Bearer token-b']);
  assert.equal(users.getTodayUsageCount(user.id),before+2);
  assert.equal(db.prepare("SELECT count(*) n FROM siwc_account_attempts").get().n,0);
  // An explicit pin must not be redirected even while B remains eligible.
  const pinned=await request({siwc_account_id:'a'});await bounded(handlers[2],'pinned completion');
  assert.equal(pinned.status,503);assert.deepEqual(selections,['a','b']);assert.equal(calls.length,2);

  // Inject local cooling only after C's admission commit. Its owned OPEN must
  // be cleaned up, but an already-admitted attempt must not become retryable.
  db.exec("UPDATE siwc_access_policy SET enabled=0 WHERE account_id IN ('a','b'); INSERT INTO siwc_accounts VALUES('c','C'),('d','D'); INSERT INTO siwc_access_policy VALUES('c',1,'all'),('d',1,'all')");
  for(const id of ['c','d']) store.create(id,{issuer:'https://auth.openai.com',subject:id,clientId:id,accessToken:`token-${id}`,idToken:'fixture-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const exec=Database.prototype.exec;let injected=false;
  Database.prototype.exec=function(sql){
   const admitted=sql==='COMMIT' && this.inTransaction && !injected && !!this.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='c'").get();
   const result=exec.call(this,sql);
   if(admitted){injected=true;accountPool.recordSiwcFailure('c',store.readSnapshot('c').revision);}
   return result;
  };
  try {
   const result=await request({strategy:'priority'});await bounded(handlers[3],'post-admission completion');
   assert.equal(result.status,503);assert.equal(injected,true);assert.deepEqual(selections,['a','b','c']);assert.equal(calls.length,2);
   assert.equal(db.prepare("SELECT count(*) n FROM siwc_account_attempts WHERE account_id='c'").get().n,0);
  } finally {Database.prototype.exec=exec;}

  // Simulate a lost acknowledgement after an actual read-only COMMIT; even
  // though E's cooling would otherwise be retryable, an error is not proof.
  db.exec("UPDATE siwc_access_policy SET enabled=0 WHERE account_id IN ('c','d'); INSERT INTO siwc_accounts VALUES('e','E'),('f','F'); INSERT INTO siwc_access_policy VALUES('e',1,'all'),('f',1,'all')");
  for(const id of ['e','f']) store.create(id,{issuer:'https://auth.openai.com',subject:id,clientId:id,accessToken:`token-${id}`,idToken:'fixture-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  let lostAck=false, armed=false;
  accountPool.selectCandidate=async(...args)=>{const candidate=await originalSelect(...args);selections.push(candidate?.id);assert.equal(candidate?.id,'e');accountPool.recordSiwcFailure('e',store.readSnapshot('e').revision);armed=true;return candidate;};
  Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='COMMIT'&&armed&&!lostAck){lostAck=true;throw new Error('simulated lost commit acknowledgement');}return result;};
  try {
   const result=await request({strategy:'priority'});await bounded(handlers[4],'ambiguous completion');
   assert.equal(result.status,503);assert.equal(lostAck,true);assert.deepEqual(selections,['a','b','c','e']);assert.equal(calls.length,2);
   assert.equal(db.prepare("SELECT count(*) n FROM siwc_account_attempts WHERE account_id='e'").get().n,0);
  } finally {Database.prototype.exec=exec;}
  // A real 429 after provider dispatch is never replayed to an eligible G.
  db.exec("UPDATE siwc_access_policy SET enabled=0 WHERE account_id='e'; INSERT INTO siwc_accounts VALUES('g','G'); INSERT INTO siwc_access_policy VALUES('g',1,'all')");
  store.create('g',{issuer:'https://auth.openai.com',subject:'g',clientId:'g',accessToken:'token-g',idToken:'fixture-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  accountPool.selectCandidate=async(...args)=>{const candidate=await originalSelect(...args);selections.push(candidate?.id);return candidate;};
  const dispatched=await request({strategy:'priority'});await bounded(handlers[5],'dispatch completion');
  assert.equal(dispatched.status,429);assert.deepEqual(selections,['a','b','c','e','f']);assert.deepEqual(calls,['Bearer token-a','Bearer token-b','Bearer token-f']);
  releaseFirst();accountPool.selectCandidate=originalSelect;globalThis.fetch=nativeFetch;
  if(server){server.closeAllConnections();await bounded(new Promise((r,j)=>server.close(e=>e?j(e):r())),'server close');}
  provider.closeAllConnections();await bounded(new Promise((r,j)=>provider.close(e=>e?j(e):r())),'provider close');
  closeDatabase();
}
// A failed or unsettled handler must never race teardown of its database.
// The parent owns this process and removes the fixture only after its close.
run().then(()=>process.exit(0),error=>{
 const detail=workerFailureDiagnostic(error);
 if(process.send) process.send({type:'fixture-error',detail},()=>process.exit(1));
 else {console.error(detail);process.exit(1);}
});
