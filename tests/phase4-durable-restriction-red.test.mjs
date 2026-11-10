import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'restriction-red-'));
const file=path.join(dir,'router.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
getDb(); const repo=new AccountRepository();
let calls=[];
const server=http.createServer((req,res)=>{calls.push(req.headers.authorization); res.writeHead(429,{'content-type':'application/json'});res.end('{}');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
assert.notEqual(port,20128);
const worker=fileURLToPath(new URL('./phase4-account-quota-worker.mjs',import.meta.url));
function run(){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),worker,file,String(port)],{env:process.env,stdio:['ignore','pipe','pipe']});
 let out='',err=''; child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 const timer=setTimeout(()=>{child.kill();reject(new Error('worker timeout'));},30000);
 child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`worker ${code}: ${err} ${out}`));else resolve(out);});
});}
after(async()=>{await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('unknown-scope 429 permits another account only on a new request after restart',async()=>{
 repo.create({name:'one',provider:'openai',credentialType:'api_key',credentials:'sk-fixture-one',priority:0});
 repo.create({name:'two',provider:'openai',credentialType:'api_key',credentials:'sk-fixture-two',priority:1});
 assert.match(await run(),/RESULT:429/);
 assert.equal(calls.length,1,'first logical request must not reroute');
 const second=await run();
 assert.equal(calls.length,2,'new logical request may reach another account');
 assert.notEqual(calls[0],calls[1],'restart must avoid the account that received 429');
 assert.match(second,/RESULT:429/);
});
