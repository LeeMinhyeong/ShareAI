import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {responseStream} from './phase4-protocol-fixtures.mjs';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-shared-open-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','a'),('b','b'); INSERT INTO siwc_access_policy VALUES('a',1,'selected'),('b',1,'selected');");
for(const [id,key] of [['allowed','fixture-key'],['denied','denied-key']]) db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run(id,hashApiKey(key),id,`${id}@example.invalid`,'pro',100);
db.exec("INSERT INTO siwc_access_users VALUES('a','allowed'),('b','allowed'); INSERT INTO siwc_routing_settings(account_id,priority,weight) VALUES('a',0,1),('b',10,1)");
const store=new SiwcStore(db,new CredentialVault());
const credential=token=>({issuer:'https://auth.openai.com',subject:'synthetic',clientId:token==='fixture-b'?'fixture-b-client':'fixture-a-client',accessToken:token,idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
store.create('a',credential('fixture-a'));store.create('b',credential('fixture-b'));
const calls=[];
const provider=http.createServer((req,res)=>{calls.push(req.headers.authorization);req.resume();if(req.headers.authorization==='Bearer fixture-a'){res.writeHead(429,{'retry-after':'600'});res.end();}else{res.writeHead(200,{'content-type':'text/event-stream'});res.end(responseStream);}});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));assert.notEqual(provider.address().port,20128);
const worker=fileURLToPath(new URL('./phase4-adr0008-http-worker.mjs',import.meta.url));
const children=[];
async function start(){const child=fork(worker,[file,String(provider.address().port)],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});children.push(child);let errors='';child.stderr.on('data',x=>errors+=x);let timer;try{const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`worker exited ${code}: ${errors}`)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('worker startup timeout')),15000)})]);return message.port;}finally{clearTimeout(timer);}}
function request(port,options={},key='fixture-key'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:options}));});}
test('SIWC 429 is shared across processes and survives credential replacement and restart',{timeout:30000},async()=>{
 try{
  const one=await start(),two=await start();
  assert.equal(await request(one,{siwc_account_id:'a'},'denied-key'),404);assert.deepEqual(calls,[]);
  assert.equal(await request(one,{strategy:'priority'}),429);assert.deepEqual(calls,['Bearer fixture-a']);
  assert.equal(await request(two,{strategy:'priority'}),200);assert.deepEqual(calls,['Bearer fixture-a','Bearer fixture-b']);
  store.replace('a',credential('fixture-a-replacement'));
  assert.equal(await request(two,{siwc_account_id:'a'}),503);
  children[0].kill();await once(children[0],'exit');const restarted=await start();
  assert.equal(await request(restarted,{strategy:'priority'}),200);
  assert.deepEqual(calls,['Bearer fixture-a','Bearer fixture-b','Bearer fixture-b']);
 }finally{
  for(const child of children) if(child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit').catch(()=>{});}
  await new Promise(r=>provider.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});
 }
});
