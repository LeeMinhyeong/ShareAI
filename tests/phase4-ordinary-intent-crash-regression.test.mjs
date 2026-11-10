import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'ordinary-intent-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
getDb(); const repo=new AccountRepository();
const a=repo.create({name:'a',provider:'openai',credentialType:'api_key',credentials:'sk-fixture-a',priority:0});
repo.create({name:'b',provider:'openai',credentialType:'api_key',credentials:'sk-fixture-b',priority:10});
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'fixture',email:'fixture@example.invalid',tier:'pro',dailyLimit:100});
const calls=[];
let observedA;const providerObserved=new Promise(resolve=>{observedA=resolve});
const provider=http.createServer((req,res)=>{const auth=req.headers.authorization;calls.push(auth);req.resume();if(auth==='Bearer sk-fixture-a'){observedA();}else{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve)); assert.notEqual(provider.address().port,20128);
const worker=fileURLToPath(new URL('./phase4-ordinary-intent-crash-worker.mjs',import.meta.url)); const children=[];
async function start(hold=false){
 const child=fork(worker,[file,String(provider.address().port),hold?'hold':'pass'],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});children.push(child);let errors='';child.stderr.on('data',x=>errors+=x);
 let timer;try{const [message]=await Promise.race([once(child,'message'),once(child,'exit').then(([code])=>{throw new Error(`worker exited ${code}: ${errors}`)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('worker startup timeout')),15000)})]);return {child,port:message.port};}finally{clearTimeout(timer)}
}
function request(port){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy:'priority'}}));});}
test('crashed in-flight account remains blocked while a different process can use B',{timeout:30000},async()=>{
 try{
  const one=await start();
  const abandoned=request(one.port); abandoned.catch(()=>{});
  let timer;try{await Promise.race([providerObserved,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('provider observation timeout')),10000)})]);}finally{clearTimeout(timer)}
  assert.deepEqual(calls,['Bearer sk-fixture-a']);
  const exit=once(one.child,'exit');one.child.kill();await exit;await abandoned.catch(()=>{});
  const db=getDb();const attempt=db.prepare('SELECT attempt_id FROM ordinary_account_attempts WHERE account_id=?').get(a.id);assert.ok(attempt);
  repo.update(a.id,{credentials:'sk-fixture-replaced'});assert.deepEqual(db.prepare('SELECT attempt_id FROM ordinary_account_attempts WHERE account_id=?').get(a.id),attempt);
  db.exec('CREATE TEMP TABLE saved_account AS SELECT * FROM main.upstream_accounts WHERE 0');
  db.prepare('INSERT INTO temp.saved_account SELECT * FROM main.upstream_accounts WHERE id=?').run(a.id);
  db.prepare('DELETE FROM main.upstream_accounts WHERE id=?').run(a.id);
  db.exec('INSERT INTO main.upstream_accounts SELECT * FROM temp.saved_account; DROP TABLE temp.saved_account');
  assert.deepEqual(db.prepare('SELECT attempt_id FROM ordinary_account_attempts WHERE account_id=?').get(a.id),attempt);
  const two=await start();
  const status=await request(two.port);
  assert.deepEqual(calls,['Bearer sk-fixture-a','Bearer sk-fixture-b'],'a crashed attempt must not allow account A to be re-dispatched');
  assert.equal(status,200);
 }finally{
  for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit.catch(()=>{})}}
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));closeDatabase();rmSync(dir,{recursive:true,force:true});
 }
});
