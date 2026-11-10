import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'vertical-')), base=path.join(dir,'base.sqlite');
Object.assign(process.env,{DATABASE_URL:`sqlite:${base}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),NODE_ENV:'test',LOG_LEVEL:'error'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault,hashApiKey}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {migrateLedger}=await import('../src/db/durable-ledger-foundation.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(); db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','a'),('b','b'); INSERT INTO siwc_access_policy VALUES('a',1,'selected'),('b',1,'selected');");
db.prepare('INSERT INTO users(id,api_key_hash,name,email,tier,daily_limit) VALUES(?,?,?,?,?,?)').run('u',hashApiKey('fixture-key'),'u','u@example.invalid','pro',100);
db.exec("INSERT INTO siwc_access_users VALUES('a','u'),('b','u')");
const store=new SiwcStore(db,new CredentialVault());
for(const id of ['a','b']) store.create(id,{issuer:'https://auth.openai.com',subject:'s',clientId:`client-${id}`,accessToken:`synthetic-${id}`,idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
migrateLedger(db);closeDatabase();
const worker=fileURLToPath(new URL('./phase4-siwc-vertical-worker.mjs',import.meta.url));
const delay=(promise,ms=8000)=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('barrier timeout')),ms);t.unref();})]);
async function boot(file,url) {const p=fork(worker,[],{execArgv:['--import',import.meta.resolve('tsx')],env:{...process.env,DATABASE_URL:`sqlite:${file}`,TEST_PROVIDER_URL:url},stdio:['ignore','ignore','pipe','ipc']});let err='';p.stderr.on('data',x=>err+=x); const [msg]=await delay(Promise.race([once(p,'message'),once(p,'exit').then(()=>{throw Error(`worker exited: ${err}`);})])); assert.ok(msg.port && msg.port!==20128);return {p,port:msg.port};}
async function stop(w) {if(w.p.exitCode!==null||w.p.signalCode!==null)return;const exit=once(w.p,'exit');w.p.kill();await delay(exit);}
const send=(w,body,key='fixture-key')=>fetch(`http://127.0.0.1:${w.port}/experimental-chat`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body)});
function fixture(name){const file=path.join(dir,name+'.sqlite');copyFileSync(base,file);return file;}
const rows=file=>{const d=new Database(file,{readonly:true});try{return {attempts:d.prepare('SELECT state FROM phase4_experimental_ledger_attempts').all(),restrictions:d.prepare('SELECT reason FROM phase4_experimental_ledger_restrictions').all()};}finally{d.close();}};
function assertIntentNoSecrets(file){const d=new Database(file,{readonly:true});try {const attempts=d.prepare('SELECT * FROM phase4_experimental_ledger_attempts').all(),claims=d.prepare('SELECT * FROM phase4_experimental_ledger_dispatch_claims').all(),restrictions=d.prepare('SELECT * FROM phase4_experimental_ledger_restrictions').all();assert.equal(attempts.length,1);assert.equal(claims.length,1);assert.equal(claims[0].attempt_id,attempts[0].id);const serialized=JSON.stringify({attempts,claims,restrictions});for(const secret of ['fixture-key','synthetic-a','synthetic-b','client-a','client-b'])assert.ok(!serialized.includes(secret));}finally{d.close();}}
test('authenticated multiprocess SIWC vertical preserves OPEN and terminal success', {timeout:30000},async()=>{
 const file=fixture('success');let entered;const arrival=new Promise(r=>entered=r);let release;const hold=new Promise(r=>release=r);let calls=0;
 const provider=http.createServer(async(req,res)=>{calls++;entered();res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');await hold;res.end('data: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n');});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a,b;
 try {const url=`http://127.0.0.1:${provider.address().port}`;a=await boot(file,url);b=await boot(file,url);
  assert.equal((await send(a,{account:'a'},'bad')).status,401);
  const pending=send(a,{account:'a'});await delay(arrival);assert.deepEqual(rows(file).attempts,[{state:'OPEN'}]);assertIntentNoSecrets(file);
  assert.equal((await send(b,{account:'b'})).status,503);assert.equal(calls,1);assert.deepEqual(rows(file).attempts,[{state:'OPEN'}]);
  release();const response=await delay(pending);assert.equal(response.status,200);assert.deepEqual((await response.json()).terminal,{id:'r',finish:'stop'});assert.deepEqual(rows(file).attempts,[{state:'SUCCESS'}]);assert.equal(calls,1);
 } finally {release();if(a)await stop(a);if(b)await stop(b);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('429 restriction survives worker restart and blocks distinct account', {timeout:30000},async()=>{
 const file=fixture('limit');let calls=0;const provider=http.createServer((_req,res)=>{calls++;res.writeHead(429);res.end();});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a,b;
 try {const url=`http://127.0.0.1:${provider.address().port}`;a=await boot(file,url);b=await boot(file,url);
  const arrived=delay(once(a.p,'message'));const pending=send(a,{account:'a',pauseResult:true});assert.equal((await arrived)[0],'result');assert.deepEqual(rows(file),{attempts:[{state:'OPEN'}],restrictions:[]});
  assert.equal((await send(b,{account:'b'})).status,503);assert.equal(calls,1);a.p.send('releaseResult');assert.equal((await delay(pending)).status,429);
  assert.deepEqual(rows(file),{attempts:[{state:'UNKNOWN_429'}],restrictions:[{reason:'UNKNOWN_429'}]});assertIntentNoSecrets(file);assert.equal((await send(b,{account:'b'})).status,503);await stop(b);b=undefined;await stop(a);a=undefined;b=await boot(file,url);assert.equal((await send(b,{account:'b'})).status,503);assert.equal(calls,1);}
 finally {if(a){a.p.send('releaseResult');await stop(a);}if(b)await stop(b);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('logout after selection denies before OPEN', {timeout:30000},async()=>{
 const file=fixture('logout');let calls=0;const provider=http.createServer((_req,res)=>{calls++;res.end();});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a;
 try {a=await boot(file,`http://127.0.0.1:${provider.address().port}`);const selected=delay(once(a.p,'message'));const pending=send(a,{account:'a',pause:true});assert.equal((await selected)[0],'selected');const db=new Database(file);try {new SiwcStore(db,new CredentialVault(),{initialize:false}).logout('a');} finally {db.close();}a.p.send('release');assert.equal((await delay(pending)).status,503);assert.equal(calls,0);assert.deepEqual(rows(file).attempts,[]);}
 finally {if(a)await stop(a);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('simultaneous requests dispatch once and crash leaves the fence in place', {timeout:30000},async()=>{
 const file=fixture('crash');let entered;const arrival=new Promise(r=>entered=r);let release;const hold=new Promise(r=>release=r);let calls=0;
 const provider=http.createServer(async(_req,res)=>{calls++;entered();await hold;if(!res.destroyed)res.end();});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a,b,restarted;
 try {const url=`http://127.0.0.1:${provider.address().port}`;a=await boot(file,url);b=await boot(file,url);
  const requests=[send(a,{account:'a'}).then(response=>({response,worker:a}),()=>null),send(b,{account:'b'}).then(response=>({response,worker:b}),()=>null)];
  await delay(arrival);const denied=await delay(Promise.race(requests));assert.equal(denied.response.status,503);assert.equal(calls,1);assert.deepEqual(rows(file).attempts,[{state:'OPEN'}]);
  const active=denied.worker===a?b:a;await stop(active);await Promise.all(requests);if(active===a)a=undefined;else b=undefined;
  restarted=await boot(file,url);assert.equal((await send(restarted,{account:'b'})).status,503);assert.equal(calls,1);assert.deepEqual(rows(file).attempts,[{state:'OPEN'}]);
 } finally {release();if(a)await stop(a);if(b)await stop(b);if(restarted)await stop(restarted);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('revoked ACL after selection denies HTTP dispatch', {timeout:30000},async()=>{
 const file=fixture('acl');let calls=0;const provider=http.createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n');});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a,b;
 try {const url=`http://127.0.0.1:${provider.address().port}`;a=await boot(file,url);b=await boot(file,url);const selected=delay(once(a.p,'message'));const pending=send(a,{account:'a',pause:true});assert.equal((await selected)[0],'selected');const db=new Database(file);try {db.prepare("DELETE FROM siwc_access_users WHERE account_id='a' AND user_id='u'").run();} finally {db.close();}a.p.send('release');assert.equal((await delay(pending)).status,404);assert.equal(calls,0);assert.deepEqual(rows(file).attempts,[]);assert.equal((await send(b,{account:'b'})).status,200);assert.equal(calls,1);assert.deepEqual(rows(file).attempts,[{state:'SUCCESS'}]);}
 finally {if(a)await stop(a);if(b)await stop(b);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('ACL revoked after OPEN remains fenced before dispatch', {timeout:30000},async()=>{
 const file=fixture('acl-after-open');let calls=0;const provider=http.createServer((_req,res)=>{calls++;res.end();});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a;
 try {a=await boot(file,`http://127.0.0.1:${provider.address().port}`);const opened=delay(once(a.p,'message'));const pending=send(a,{account:'a',pauseOpen:true});assert.equal((await opened)[0],'opened');assert.deepEqual(rows(file).attempts,[{state:'OPEN'}]);const db=new Database(file);try {db.prepare("DELETE FROM siwc_access_users WHERE account_id='a' AND user_id='u'").run();} finally {db.close();}a.p.send('release');assert.equal((await delay(pending)).status,404);assert.equal(calls,0);assert.deepEqual(rows(file).attempts,[{state:'OPEN'}]);}
 finally {if(a)await stop(a);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('disconnect after selection is observed before OPEN and prevents network', {timeout:30000},async()=>{
 const file=fixture('cancel');let calls=0;const provider=http.createServer((_req,res)=>{calls++;res.end();});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a;
 try {a=await boot(file,`http://127.0.0.1:${provider.address().port}`);const selected=delay(once(a.p,'message'));const abort=new AbortController();
  const pending=fetch(`http://127.0.0.1:${a.port}/experimental-chat`,{method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'},body:JSON.stringify({account:'a',pause:true}),signal:abort.signal}).catch(()=>null);
  assert.equal((await selected)[0],'selected');const cancelled=delay(once(a.p,'message'));abort.abort();assert.equal((await cancelled)[0],'cancelled');const handled=delay(once(a.p,'message'));a.p.send('release');assert.equal((await handled)[0],'handled');await pending;assert.equal(calls,0);assert.deepEqual(rows(file).attempts,[]);
 } finally {if(a)await stop(a);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test('unauthorized and missing selections cannot open the global fence', {timeout:30000},async()=>{
 const file=fixture('unauthorized');const d=new Database(file);d.prepare("DELETE FROM siwc_access_users WHERE account_id='b' AND user_id='u'").run();d.close();
 let calls=0;const provider=http.createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n');});await new Promise(r=>provider.listen(0,'127.0.0.1',r));let a,b;
 try {const url=`http://127.0.0.1:${provider.address().port}`;a=await boot(file,url);b=await boot(file,url);
  const denied=await send(a,{account:'b'}), missing=await send(a,{account:'missing'});assert.equal(denied.status,404);assert.equal(missing.status,404);assert.equal(await denied.text(),await missing.text());assert.deepEqual(rows(file).attempts,[]);assert.equal(calls,0);
  assert.equal((await send(b,{account:'a'})).status,200);assert.equal(calls,1);assert.deepEqual(rows(file).attempts,[{state:'SUCCESS'}]);
 } finally {if(a)await stop(a);if(b)await stop(b);provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
test.after(()=>rmSync(dir,{recursive:true,force:true}));
