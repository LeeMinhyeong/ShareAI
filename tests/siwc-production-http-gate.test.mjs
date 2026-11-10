import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-http-gate-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const router=(await import('../src/routes/v1.ts')).default;
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','a'); INSERT INTO siwc_access_policy VALUES('a',1,'selected');");
db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
db.exec("INSERT INTO siwc_access_users VALUES('a','u')");
const store=new SiwcStore(db,new CredentialVault());
const credential={issuer:'https://auth.openai.com',subject:'s',clientId:'fixture',accessToken:'synthetic',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()};
store.create('a',credential);
const app=express();app.use(express.json());app.use('/v1',router);
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
const originalFetch=globalThis.fetch, oldRead=SiwcStore.prototype.readSnapshot, oldExec=Database.prototype.exec;
const request=()=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}));});
after(async()=>{SiwcStore.prototype.readSnapshot=oldRead;Database.prototype.exec=oldExec;globalThis.fetch=originalFetch;await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('real /v1 rechecks ACL after OPEN commits before dispatch', {timeout:15000}, async()=>{
 let revoked=false,calls=0,openObserved=false;
 db.exec("INSERT OR IGNORE INTO siwc_access_users VALUES('a','u')");
 Database.prototype.exec=function(sql){
  if(sql==='BEGIN IMMEDIATE' && !revoked && !this.inTransaction && db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get()){
   openObserved=true;revoked=true;
   const script="const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare(\"DELETE FROM siwc_access_users WHERE account_id='a' AND user_id='u'\").run();d.close();";
   const child=spawnSync(process.execPath,['-e',script,file],{cwd:process.cwd(),env:process.env,timeout:10000,encoding:'utf8'});
   assert.equal(child.status,0,child.stderr);
  }
  return oldExec.call(this,sql);
 };
 globalThis.fetch=async()=>{calls++;return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 try {
  assert.equal(await request(),404);assert.equal(openObserved,true);assert.equal(calls,0);
  assert.equal(db.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='a'").get(),undefined);
  assert.equal(db.prepare("SELECT 1 FROM siwc_access_users WHERE account_id='a' AND user_id='u'").get(),undefined);
 } finally {Database.prototype.exec=oldExec;globalThis.fetch=originalFetch;db.exec("INSERT OR IGNORE INTO siwc_access_users VALUES('a','u')");}
});
for(const mode of ['logout','acl']) test(`real /v1 writer gate denies ${mode} committed after selection`,{timeout:15000},async()=>{
 const sequence=[];let calls=0, mutated=false;
 db.exec("INSERT OR IGNORE INTO siwc_access_users VALUES('a','u')");
 if(!store.read('a')) store.replace('a',credential);
 SiwcStore.prototype.readSnapshot=function(id){const value=oldRead.call(this,id);sequence.push(this.db.inTransaction?'gate-snapshot':'selected');return value;};
 Database.prototype.exec=function(sql){
  if(sql==='BEGIN IMMEDIATE' && !mutated && sequence.includes('selected')) {
   mutated=true;sequence.push('before-writer');
   const script=mode==='acl' ? "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare(\"DELETE FROM siwc_access_users WHERE account_id='a' AND user_id='u'\").run();d.close();" : "";
   const args=mode==='acl' ? ['-e',script,file] : ['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('./siwc-inference-logout-worker.mjs',import.meta.url)),file];
   const child=spawnSync(process.execPath,args,{cwd:process.cwd(),env:process.env,timeout:10000,encoding:'utf8'});
   assert.equal(child.status,0,child.stderr);sequence.push('revoked');
  }
  const result=oldExec.call(this,sql);if(sql==='BEGIN IMMEDIATE' && mutated && !sequence.includes('writer-acquired')) sequence.push('writer-acquired');return result;
 };
 globalThis.fetch=async()=>{calls++;sequence.push('provider');return new Response(responseStream,{headers:{'content-type':'text/event-stream'}});};
 try {
  const status=await request();sequence.push('response');assert.equal(status,mode==='acl'?404:503);assert.equal(calls,0);assert.deepEqual(sequence,mode==='acl'?['selected','before-writer','revoked','writer-acquired','response']:['selected','before-writer','revoked','writer-acquired','gate-snapshot','response']);
  SiwcStore.prototype.readSnapshot=oldRead;Database.prototype.exec=oldExec;
  db.exec("INSERT OR IGNORE INTO siwc_access_users VALUES('a','u')");
  if(!store.read('a')) store.replace('a',credential);
  assert.equal(await request(),200,'pre-dispatch denial must not cool the account');assert.equal(calls,1);
 }
 finally {SiwcStore.prototype.readSnapshot=oldRead;Database.prototype.exec=oldExec;globalThis.fetch=originalFetch;}
});
