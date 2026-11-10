import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import express from 'express';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'usage-utc-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UsageLogRepository}=await import('../src/db/repositories/usage-logs.ts');
const {parseUsageUtc}=await import('../src/db/usage-utc.ts');
const {default:admin}=await import('../src/routes/admin.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(), repo=new UsageLogRepository();
db.exec("INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','h','u','u@example.invalid','free'); CREATE TABLE IF NOT EXISTS siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('s','s')");
const account=new AccountRepository().create({name:'fixture',provider:'openai',credentialType:'api_key',credentials:'synthetic'});
const ordinary=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
const siwc=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
const app=express();app.use('/admin',admin);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
after(async()=>{await new Promise(r=>server.close(r));closeDatabase();rmSync(dir,{recursive:true,force:true});});
function frozen(iso,fn) {const RealDate=Date, now=RealDate.parse(iso);globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[now]));} static now(){return now;}};try{return fn();}finally{globalThis.Date=RealDate;}}
test('UTC day counts both formats through as-of inclusive, failures included',()=>{
 const rows=[['mid','2024-03-10 00:00:00',1],['iso','2024-03-10T08:00:00.000Z',1],['failure','2024-03-10T08:30:00.000Z',0],['asof','2024-03-10T09:00:00.000Z',1],['future','2024-03-10T09:00:00.001Z',1],['yesterday','2024-03-09T23:59:59.999Z',1],['invalid','2024-03-10T08:99:00.000Z',1],['calendar','2024-02-30T00:00:00.000Z',1]];
 for(const [id,t,success] of rows){ordinary.run('o'+id,'u',account.id,t,'m','openai',1,2,success,0);siwc.run('s'+id,'u','s',t,'m','openai',1,2,success,id==='failure'?1:0,0);}
 assert.equal(parseUsageUtc('2024-02-30T00:00:00.000Z'),null);
 frozen('2024-03-11T00:00:00.000Z',()=>assert.deepEqual(repo.getGlobalTodayCounts(),{totalRequests:0,successRequests:0}));
 for(const tz of ['UTC','America/Los_Angeles','Asia/Seoul']) {const previous=process.env.TZ;process.env.TZ=tz;try{frozen('2024-03-10T09:00:00.000Z',()=>{assert.deepEqual(repo.getTodayStats('u'),{totalRequests:8,successRequests:6,totalTokens:24,totalTokensComplete:false});assert.deepEqual(repo.getGlobalTodayCounts(),{totalRequests:8,successRequests:6});assert.deepEqual(repo.getAccountTodayStats(account.id),{totalRequests:4,successRequests:3,totalTokens:12,totalTokensComplete:false});assert.deepEqual(repo.getTodayStats('missing'),{totalRequests:0,successRequests:0,totalTokens:0,totalTokensComplete:true});});}finally{if(previous===undefined) delete process.env.TZ;else process.env.TZ=previous;}}
});
test('real authenticated stats endpoint retains its actual response shape without credentials',async()=>{
 const current=new Date().toISOString();
 ordinary.run('current-o','u',account.id,current,'m','openai',1,2,1,0);
 siwc.run('current-s','u','s',current,'m','openai',1,2,0,0,0);
 const url=`http://127.0.0.1:${server.address().port}/admin/stats`;
 assert.equal((await fetch(url)).status,401);
 const response=await fetch(url,{headers:{authorization:`Bearer ${process.env.ADMIN_API_KEY}`}});assert.equal(response.status,200);
 const text=await response.text();assert.doesNotMatch(text,/synthetic|api_key|credentials|token/i);const body=JSON.parse(text);assert.equal(body.users.total,1);assert.equal(body.accounts.total,1);assert.equal(body.accounts.byProvider.openai,1);assert.deepEqual(body.todayUsage,{totalRequests:2,successRequests:1});
 const headers={authorization:`Bearer ${process.env.ADMIN_API_KEY}`};
 const userResponse=await fetch(`http://127.0.0.1:${server.address().port}/admin/users/u`,{headers});assert.equal(userResponse.status,200);assert.deepEqual((await userResponse.json()).todayStats,{totalRequests:2,successRequests:1,totalTokens:6,totalTokensComplete:false});
 const accountResponse=await fetch(`http://127.0.0.1:${server.address().port}/admin/accounts/${account.id}`,{headers});assert.equal(accountResponse.status,200);assert.deepEqual((await accountResponse.json()).todayStats,{totalRequests:1,successRequests:1,totalTokens:3,totalTokensComplete:false});
});
