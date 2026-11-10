import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-open-crash-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','a'),('b','b'); INSERT INTO siwc_access_policy VALUES('a',1,'all'),('b',1,'all'); INSERT INTO siwc_routing_settings(account_id,priority,weight) VALUES('a',0,1),('b',10,1)");
db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
const store=new SiwcStore(db,new CredentialVault());
const credential=(id,token)=>({issuer:'https://auth.openai.com',subject:'synthetic',clientId:`fixture-${id}`,accessToken:token,idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
store.create('a',credential('a','fixture-a'));store.create('b',credential('b','fixture-b'));
let received;const receipt=new Promise(r=>received=r);const calls=[];let held;
const provider=http.createServer((req,res)=>{calls.push(req.headers.authorization);req.resume();if(req.headers.authorization==='Bearer fixture-a'){held=res;received();}else{res.writeHead(200,{'content-type':'text/event-stream'});res.end(responseStream);}});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));assert.notEqual(provider.address().port,20128);
const worker=fileURLToPath(new URL('./phase4-adr0008-http-worker.mjs',import.meta.url));const children=[];
async function start(){const child=fork(worker,[file,String(provider.address().port)],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});children.push(child);let errors='';child.stderr.on('data',x=>errors+=x);let timer;try{const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`worker exited ${code}: ${errors}`)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('worker startup timeout')),15000)})]);return {child,port:message.port};}finally{clearTimeout(timer);}}
function request(port,options={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:options}));});}
function bounded(promise,ms=8000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('barrier timeout')),ms)})]).finally(()=>clearTimeout(timer));}
test('provider receipt then worker death leaves stable SIWC OPEN after restart',{timeout:30000},async()=>{
 let pending;
 try{
  const first=await start();pending=request(first.port,{siwc_account_id:'a'}).catch(()=>{});
  await bounded(receipt);assert.deepEqual(calls,['Bearer fixture-a']);
  first.child.kill();await bounded(once(first.child,'exit'));await pending;
  store.replace('a',credential('a','fixture-a-replacement'));
  const restarted=await start();
  assert.equal(await bounded(request(restarted.port,{siwc_account_id:'a'})),503);
  assert.equal(await bounded(request(restarted.port,{strategy:'priority'})),200);
  assert.deepEqual(calls,['Bearer fixture-a','Bearer fixture-b']);
  assert.ok(db.prepare('SELECT 1 FROM siwc_account_attempts WHERE account_id=?').get('a'));
 }finally{
  if(held) held.destroy();
  for(const child of children) if(child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit').catch(()=>{});}
  await new Promise(r=>provider.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});
 }
});
