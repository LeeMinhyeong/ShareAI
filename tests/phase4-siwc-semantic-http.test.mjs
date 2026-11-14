import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {responseStream} from './phase4-protocol-fixtures.mjs';

// Synthetic fixtures; no actual credentials or provider calls.
const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-semantic-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec('CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL)');
db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
const store=new SiwcStore(db,new CredentialVault());
const base=()=>({type:'response.failed',sequence_number:5,response:{id:'resp_1',status:'failed',error:{code:'subscription_sharing_usage_limit_exceeded',message:'usage limit'}}});
const frame=(e,name)=>`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(e)}\n\n`;
const prefix=responseStream.split('data: ').filter(Boolean).slice(0,5).map(x=>'data: '+x).join('');
let mode; let calls=0; let sawOpen=false;
const provider=http.createServer((req,res)=>{calls++; sawOpen=!!db.prepare('SELECT 1 FROM siwc_account_attempts WHERE account_id=?').get(mode.id);req.resume();
 if(mode.http429){res.writeHead(429);res.end();return;}
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(mode.body);
});
function request(port,id,stream=false){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],stream,router_options:{siwc_account_id:id}}));});}
test('authenticated SIWC route trusts only unambiguous semantic limits after OPEN',{timeout:30000},async()=>{
 let child;
 try {
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));assert.notEqual(provider.address().port,20128);
  child=fork(fileURLToPath(new URL('./phase4-adr0008-http-worker.mjs',import.meta.url)),[file,String(provider.address().port)],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);let timer;
  const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`worker exited ${code}: ${stderr}`)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('worker timeout')),15000)})]).finally(()=>clearTimeout(timer));
  const cases=[
   {id:'delta',body:frame({...base(),delta:'contradiction'}),status:502,rest:true},
   {id:'response-extra',body:frame({...base(),response:{...base().response,extra:true}}),status:502,rest:true},
   {id:'error-extra',body:frame({...base(),response:{...base().response,error:{...base().response.error,extra:true}}}),status:502,rest:true},
   {id:'wrong-event',body:frame(base(),'response.output_text.delta'),status:502,rest:true},
   {id:'wrong-status',body:frame({...base(),response:{...base().response,status:'completed'}}),status:502,rest:true},
   {id:'wrong-id',body:prefix+frame({...base(),response:{...base().response,id:'resp_other'}}),status:502,rest:true},
   {id:'missing-sequence',body:frame({type:'response.failed',response:base().response}),status:502,rest:true},
   {id:'partial-invalid',body:prefix+frame({...base(),delta:'contradiction'}),status:200,rest:true,stream:true,invalidStream:true},
   {id:'valid',body:frame(base(),'response.failed'),status:429,cool:true},
   {id:'partial',body:prefix+frame(base(),'response.failed'),status:200,cool:true,stream:true},
   {id:'http',http429:true,status:429,cool:true},
   {id:'success',body:responseStream,status:200}
  ];
  for(const c of cases){
   db.prepare('INSERT INTO siwc_accounts VALUES (?,?)').run(c.id,c.id);
   db.prepare("INSERT INTO siwc_access_policy VALUES (?,1,'selected')").run(c.id);
   db.prepare('INSERT INTO siwc_access_users VALUES (?,?)').run(c.id,'u');
   store.create(c.id,{issuer:'https://auth.openai.com',subject:'synthetic',clientId:c.id,accessToken:'synthetic-'+c.id,idToken:'synthetic',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
   mode=c;calls=0;sawOpen=false;const result=await request(ready.port,c.id,c.stream);
   assert.equal(result.status,c.status,c.id);assert.equal(calls,1,c.id);assert.equal(sawOpen,true,c.id);
   // ADR 0008 (2026-11-13): an untrusted envelope is a 2xx response the router cannot use. It is never a 429 to the
   // client and never a 429 settlement; the OPEN becomes the fixed 60s restriction (rest). A trusted limit (cool)
   // keeps its own 429 duration.
   assert.equal(db.prepare('SELECT 1 FROM siwc_account_attempts WHERE account_id=?').get(c.id),undefined,c.id);
   const armed=db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='siwc' AND account_id=?").get(c.id);
   assert.equal(!!armed,!!(c.cool||c.rest),c.id);
   if(c.rest)assert.equal(Number(armed.duration_ms),60000,c.id);
   if(c.cool)assert.equal(Number(armed.duration_ms),5000,`${c.id}: a trusted limit without a hint is settled as a 429 (5s minimum)`);
   if(c.stream){assert.match(result.body,/hello/);assert.match(result.body,c.invalidStream ? /Upstream stream failed/ : /subscription_sharing_usage_limit_exceeded/);assert.doesNotMatch(result.body,/\[DONE\]/);}
   if(c.rest){assert.equal((await request(ready.port,c.id)).status,503,c.id);assert.equal(calls,1,c.id);}
  }
 } finally {if(child && child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit').catch(()=>{});}await new Promise(r=>provider.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});}
});
