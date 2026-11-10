import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-usage-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase,initDatabase,provisionFreshSafetySchema}=await import('../src/db/client.ts');
// The production client never creates a database; provision a test-owned fresh one.
{const {default:Database}=await import('better-sqlite3');const raw=new Database(file);raw.transaction(()=>provisionFreshSafetySchema(raw)).immediate();raw.close();}
initDatabase();
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const db=getDb();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('fixture-private-account-marker','fixture-private-account-marker'); INSERT INTO siwc_access_policy VALUES('fixture-private-account-marker',1,'selected'); INSERT INTO siwc_routing_settings(account_id,priority,weight) VALUES('fixture-private-account-marker',0,1)");
db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
db.exec("INSERT INTO siwc_access_users VALUES('fixture-private-account-marker','u')");
new SiwcStore(db,new CredentialVault()).create('fixture-private-account-marker',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'fixture',accessToken:'fixture-access-token-marker',idToken:'fixture-id-token-marker',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
function bounded(p,ms=10000){let timer;return Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('timeout')),ms))]).finally(()=>clearTimeout(timer));}
async function waitFor(fn){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw new Error('database condition timeout');}
const worker=fileURLToPath(new URL('./siwc-usage-cancel-worker.mjs',import.meta.url));
for(const mode of ['selection','open','started','throw','reject','stale','success','acl']) test(`SIWC ${mode} usage reflects physical dispatch`,{timeout:30000},async()=>{
 let child,req,held;let calls=0,received;const receipt=new Promise(r=>received=r);
 const provider=http.createServer((request,response)=>{calls++;request.resume();received();if(mode==='started')held=response;else{response.writeHead(200,{'content-type':'text/event-stream'});response.end(responseStream);}});
 const before=db.prepare("SELECT COALESCE(SUM(used),0) n FROM user_daily_quota WHERE user_id='u'").get().n;
 db.exec('DELETE FROM siwc_usage_logs; DELETE FROM siwc_account_attempts; DELETE FROM account_429_cooldowns; DELETE FROM account_429_v2_restrictions');
 if(mode==='acl')db.exec("DELETE FROM siwc_access_users WHERE account_id='fixture-private-account-marker' AND user_id='u'");
 try{
  await bounded(new Promise(r=>provider.listen(0,'127.0.0.1',r)));assert.notEqual(provider.address().port,20128);
  child=fork(worker,[file,String(provider.address().port),mode],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
  let output='',overflow=false;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(output.length+chunk.length>100000){overflow=true;child.kill();}else output+=chunk.toString();});
  const closed=once(child,'close');
  const events=[];let notify;child.on('message',m=>{events.push(m);notify?.();});
  async function event(name){return bounded((async()=>{for(;;){const i=events.findIndex(m=>m.event===name);if(i>=0)return events.splice(i,1)[0];if(child.exitCode!==null||child.signalCode!==null)throw new Error('worker exited before event');await new Promise(r=>notify=r);notify=undefined;}})());}
  const ready=await event('ready');
  let responseResolve;const response=new Promise(r=>responseResolve=r);
  let responseBody='';
  req=http.request({host:'127.0.0.1',port:ready.port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.on('data',chunk=>responseBody+=chunk.toString());res.on('end',()=>responseResolve(res.statusCode));});req.on('error',()=>{});
  req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:mode==='acl'?{siwc_account_id:'fixture-private-account-marker'}:{strategy:'priority'}}));
  if(['success','throw','reject','stale','acl'].includes(mode)) assert.equal(await bounded(response),mode==='success'?200:mode==='reject'?502:mode==='acl'?404:503);
  else {
   if(mode==='started') await bounded(receipt);else await event(mode);
   if(mode==='open')assert.ok(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='fixture-private-account-marker'").get());
   req.destroy();await event('closed');child.send('release');
  }
  const done=await event('done');
  assert.equal(done.fetchCalls,['started','throw','reject','stale','success'].includes(mode)?1:0);
  if(['selection','open','started','acl'].includes(mode)) assert.equal(done.state,undefined);
  if(mode==='throw'||mode==='reject') {
   const revision=db.prepare("SELECT revision FROM siwc_credentials WHERE id='fixture-private-account-marker'").get().revision;
   assert.equal(done.state?.revision,revision);
   assert.equal(done.state?.consecutiveFails,1);
   assert.ok(done.state?.cooldownUntil>Date.now());
  }
  if(mode==='stale') {
   assert.equal(db.prepare("SELECT revision FROM siwc_credentials WHERE id='fixture-private-account-marker'").get().revision,'fixture-new-revision');
   assert.equal(done.state?.revision,'fixture-new-revision');
   assert.equal(done.state?.consecutiveFails,1);
   assert.ok(done.state?.cooldownUntil>Date.now());
  }
  await waitFor(()=>db.prepare("SELECT COALESCE(SUM(used),0) n FROM user_daily_quota WHERE user_id='u'").get().n===before+1);
  if(['started','success','throw','reject','stale'].includes(mode))await waitFor(()=>db.prepare('SELECT COUNT(*) n FROM siwc_usage_logs').get().n===1);
  else if(mode==='open')await waitFor(()=>!db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='fixture-private-account-marker'").get());
  // Stop the server gracefully to ensure the completed request's finally block ran.
  child.send('stop');await bounded(closed);assert.equal(child.exitCode,0);assert.equal(overflow,false);
  if(['throw','reject','stale','acl'].includes(mode))assert.ok(output.includes('Inference request failed'),'expected server failure log');
  for(const marker of ['fixture-key','fixture-access-token-marker','fixture-id-token-marker','fixture-private-account-marker','a'.repeat(64),'x'.repeat(20)]) {
   assert.equal(output.includes(marker),false,'worker output leaked sensitive fixture data');
   assert.equal(responseBody.includes(marker),false,'response leaked sensitive fixture data');
  }
  const logs=db.prepare('SELECT success,aborted FROM siwc_usage_logs').all();
  assert.deepEqual(logs,mode==='started'?[{success:0,aborted:1}]:(mode==='throw'||mode==='reject'||mode==='stale')?[{success:0,aborted:0}]:mode==='success'?[{success:1,aborted:0}]:[]);
  if(['throw','reject','stale'].includes(mode))assert.equal(db.prepare('SELECT status FROM siwc_usage_logs').get().status,mode==='reject'?502:503);
  assert.equal(calls,mode==='started'||mode==='success'?1:0);
  // ADR 0008 (2026-11-09): a client disconnect after dispatch converts the OPEN into a 60s restriction.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM siwc_account_attempts WHERE account_id='fixture-private-account-marker'").get().n,mode==='throw'||mode==='reject'||mode==='stale'?1:0);
  if(mode==='started')assert.equal(Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='fixture-private-account-marker'").get()?.duration_ms),60000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account_429_cooldowns WHERE kind='siwc' AND account_id='fixture-private-account-marker'").get().n,0);
  assert.equal(db.prepare("SELECT COALESCE(SUM(used),0) n FROM user_daily_quota WHERE user_id='u'").get().n,before+1);
 }finally{
  req?.destroy();held?.destroy();if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await bounded(once(child,'exit'));}
  await bounded(new Promise(r=>provider.close(r)));
 }
});
import {after} from 'node:test';
after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});
