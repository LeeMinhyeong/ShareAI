import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'adr0008-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
getDb();const repo=new AccountRepository();
repo.create({name:'a',provider:'openai',credentialType:'api_key',credentials:'sk-fixture-a',priority:0});
repo.create({name:'b',provider:'openai',credentialType:'api_key',credentials:'sk-fixture-b',priority:10});
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'fixture',email:'fixture@example.invalid',tier:'pro',dailyLimit:100});
const calls=[];
// A complete Chat Completions stream: the parser rejects a bare [DONE] as an incomplete upstream stream.
const completeStream='data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const provider=http.createServer((req,res)=>{calls.push(req.headers.authorization);req.resume();if(req.headers.authorization==='Bearer sk-fixture-a'){res.writeHead(429);res.end();} else {res.writeHead(200,{'content-type':'text/event-stream'});res.end(completeStream);}});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));assert.notEqual(provider.address().port,20128);
const worker=fileURLToPath(new URL('./phase4-adr0008-http-worker.mjs',import.meta.url));
const children=[];
async function start(){
 const child=fork(worker,[file,String(provider.address().port)],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});children.push(child);
 let errors='';child.stderr.on('data',x=>errors+=x);
 let timer;try {const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`worker exited ${code}: ${errors}`)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('worker startup timeout')),15000);})]);return message.port;} finally {clearTimeout(timer);}
}
function request(port,key='fixture-key'){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy:'priority'}}));});}
test('429 is persisted before response and a different process chooses B only for a new authenticated request',{timeout:30000},async()=>{
 try {
  const one=await start(),two=await start();
  assert.equal(await request(one,'invalid-key'),401);assert.equal(calls.length,0);
  assert.equal(await request(one),429);assert.deepEqual(calls,['Bearer sk-fixture-a'],'first request must not retry');
  assert.equal(await request(two),200);assert.deepEqual(calls,['Bearer sk-fixture-a','Bearer sk-fixture-b']);
  children[0].kill(); await once(children[0],'exit');
  const restarted=await start();
  assert.equal(await request(restarted),200);
  assert.deepEqual(calls,['Bearer sk-fixture-a','Bearer sk-fixture-b','Bearer sk-fixture-b'],'restart must retain the account cooldown');
 } finally {
  for(const child of children) {if(child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit').catch(()=>{});}}
  await new Promise(r=>provider.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});
 }
});
