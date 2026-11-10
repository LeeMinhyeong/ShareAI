import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-refresh-admission-'));
const file=path.join(dir,'fixture.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','A'),('b','B'); INSERT INTO siwc_access_policy VALUES('a',1,'selected'),('b',1,'selected');");
db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
db.exec("INSERT INTO siwc_access_users VALUES('a','u'),('b','u')");
const store=new SiwcStore(db,new CredentialVault());
const base={issuer:'https://auth.openai.com',subject:'s',idToken:'fixture-id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access','chatgpt.tokens.use.direct']};
store.create('a',{...base,clientId:'client-a',accessToken:'fixture-initial-access',refreshToken:'initial-refresh',savedAt:new Date().toISOString()});
store.create('b',{...base,clientId:'client-b',accessToken:'b-access',savedAt:new Date().toISOString()});
const userRepo=new UserRepository();
const worker=fileURLToPath(new URL('./phase4-siwc-refresh-admission-worker.mjs',import.meta.url));
const bounded=(promise,ms,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(timer));};
function request(port,key='fixture-key') {return bounded(new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},timeout:8000},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('timeout',()=>req.destroy(new Error('request timeout')));req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}],router_options:{strategy:'priority'}}));}),10000,'HTTP');}
function probe(port,path,method='GET',body) {return bounded(new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers:body?{'content-type':'application/json'}:{},timeout:8000},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,body:data}));});req.on('timeout',()=>req.destroy(new Error('probe timeout')));req.on('error',reject);req.end(body);}),10000,'probe');}
after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});
for(const mode of ['refresh','control']) for(const restriction of ['open','cooldown']) test(`${mode}: independent ${restriction} commit after selection`,{timeout:30000},async()=>{
 db.exec("DELETE FROM siwc_account_attempts; DELETE FROM account_429_cooldowns; DELETE FROM account_429_v2_restrictions; DELETE FROM siwc_usage_logs;");
 const token=`old-refresh-${mode}-${restriction}`;
 store.replace('a',{...base,clientId:'client-a',accessToken:mode==='refresh'?'expired-access':'valid-access',refreshToken:token,savedAt:mode==='refresh'?'2020-01-01T00:00:00.000Z':new Date().toISOString()});
 const before=store.readSnapshot('a');
 const calls={refresh:[],inference:[]};
 const provider=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  if(req.url==='/refresh'){calls.refresh.push({body,method:req.method});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({access_token:'rotated-access',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600}));}
  else if(req.url==='/inference'){calls.inference.push(req.headers.authorization);res.writeHead(200,{'content-type':'text/event-stream'});res.end(responseStream);}
  else {res.writeHead(404);res.end();}
 });});
 let child,childClosed;let stderr='',stdout='';const messages=[];
 const sensitive=['expired-access','valid-access','rotated-access','rotated-refresh',token,'b-access','fixture-key','wrong-key','fixture-id','initial-refresh','fixture-initial-access','client-a','client-b','x'.repeat(20),'a'.repeat(64)];
 const assertNoLeaks=() => assert.equal(sensitive.some(value => stdout.includes(value) || stderr.includes(value)),false,'worker output contains synthetic credential material');
 try {
  provider.listen(0,'127.0.0.1');await bounded(once(provider,'listening'),5000,'provider listen');assert.notEqual(provider.address().port,20128);
  const env=Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP','TMPDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  child=fork(worker,[file,String(provider.address().port),mode,restriction],{cwd:dir,env,execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
  childClosed=once(child,'close');
  child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',c=>stdout+=c);child.on('message',m=>messages.push(m));
  const [ready]=await bounded(Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`worker exited ${code}`);})]),10000,'worker ready');
  assert.equal(ready.event,'ready');assert.notEqual(ready.pid,process.pid);assert.notEqual(ready.port,20128);
  assert.equal((await probe(ready.port,'/health')).status,200);
  const malformed=await probe(ready.port,'/v1/chat/completions','POST','{');
  assert.equal(malformed.status,400);assert.deepEqual(JSON.parse(malformed.body),{error:{type:'invalid_request',message:'Invalid JSON'}});
  const usage=userRepo.getTodayUsageCount('u');
  assert.equal((await request(ready.port,'wrong-key')).status,401);assert.equal(userRepo.getTodayUsageCount('u'),usage);
  const response=await request(ready.port);
  let commit=messages.find(m=>m.event==='committed');
  if(!commit) {const [message]=await bounded(once(child,'message'),3000,'commit notification');commit=message;}
  assert.equal(commit.event,'committed','missing committed barrier');assert.notEqual(commit.pid,ready.pid);assert.notEqual(commit.pid,process.pid);assert.equal(commit.restriction,restriction);
  const selectionReply=once(child,'message'); child.send('selections');
  const [selectionMessage]=await bounded(selectionReply,3000,'selection report');
  assert.equal(selectionMessage.event,'selections');
  assert.deepEqual(selectionMessage.selections,mode==='refresh'?['a']:['a','b']);
  assert.equal(response.status,mode==='refresh'?503:200,'unexpected response status');
  assert.equal(userRepo.getTodayUsageCount('u'),usage+1);
  assert.equal(calls.refresh.length,mode==='refresh'?1:0);
  if(mode==='refresh') {const form=new URLSearchParams(calls.refresh[0].body);assert.equal(calls.refresh[0].method,'POST');assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),token);assert.equal(form.get('client_id'),'client-a');const after=store.readSnapshot('a');assert.notEqual(after.revision,before.revision);assert.equal(after.credential.accessToken,'rotated-access');assert.equal(after.credential.refreshToken,'rotated-refresh');}
  assert.deepEqual(calls.inference,mode==='refresh'?[]:['Bearer b-access']);
  assert.equal(sensitive.some(value => response.body.includes(value)),false,'response contains synthetic credential material');
  assert.equal(sensitive.some(value => JSON.stringify(db.prepare('SELECT credentials FROM siwc_credentials').all()).includes(value)),false,'stored credentials contain plaintext synthetic credential material');
  if(restriction==='open') assert.equal(db.prepare("SELECT attempt_id FROM siwc_account_attempts WHERE account_id='a'").get()?.attempt_id,'competitor');
  else assert.ok(db.prepare("SELECT 1 FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id='a'").get(), 'v2 restriction armed');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM siwc_account_attempts WHERE account_id='b'").get().n,0);
 } finally {
  if(child && child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.send('stop');try {await bounded(exited,5000,'worker stop');} catch {child.kill();await bounded(exited,5000,'worker kill');}}
  provider.closeAllConnections();await bounded(new Promise((resolve,reject)=>provider.close(e=>e?reject(e):resolve())),5000,'provider close');
  if(childClosed) await bounded(childClosed,5000,'worker streams close');
  assertNoLeaks();
 }
});
