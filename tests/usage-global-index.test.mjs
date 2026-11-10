import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import express from 'express';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'usage-index-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {UsageLogRepository}=await import('../src/db/repositories/usage-logs.ts');
const {parseUsageUtc}=await import('../src/db/usage-utc.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('global today uses timestamp index in each branch without changing strict UTC results',()=>{
 db.pragma('foreign_keys = OFF');
 const a=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const b=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 const now=Date.parse('2024-03-10T09:00:00.000Z'), start=Date.parse('2024-03-10T00:00:00.000Z');
 const rows=['2024-03-10 00:00:00','2024-03-10T09:00:00.000Z','2024-03-10T09:00:00.001Z','2024-03-10T08:99:00.000Z','2024-03-09T23:59:59.999Z',"2024-03-10T08:00:00.000Z' OR 1=1--"];
 let seed=12345;for(let i=0;i<1000;i++){seed=(seed*16807)%2147483647;const t=new Date(start+(seed%259200000)-86400000).toISOString();rows.push(i%2?t:t.slice(0,19).replace('T',' '));}
 db.transaction(()=>rows.forEach((t,i)=>{a.run('a'+i,'u','a',t,'m','openai',0,0,i%2,0);b.run('b'+i,'u','s',t,'m','openai',0,0,i%2,i%3===0?1:0,0);} ))();
 const valid=rows.filter(t=>{const ms=parseUsageUtc(t);return ms!==null&&ms>=start&&ms<=now;});
 const expected={totalRequests:valid.length*2,successRequests:rows.reduce((n,t,i)=>{const ms=parseUsageUtc(t);return n+(ms!==null&&ms>=start&&ms<=now?2*(i%2):0);},0)};
 const realDate=Date, originalPrepare=db.prepare;let sql, bound;
 db.prepare=function(s,...args){const stmt=originalPrepare.call(this,s,...args);if(s.includes('COUNT(*) AS total')&&s.includes('siwc_usage_logs')){sql=s;return {get(params){bound=params;return stmt.get(params);}};}return stmt;};
 globalThis.Date=class extends realDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
 try{
  const repo=new UsageLogRepository();assert.deepEqual(repo.getGlobalTodayCounts(),expected);
  assert.equal(bound.sqliteEnd, '2024-03-10 09:00:00');
  assert.equal(bound.isoEnd, '2024-03-10T09:00:00.000Z');
  db.exec('CREATE INDEX usage_ts_test ON usage_logs(timestamp); CREATE INDEX siwc_ts_test ON siwc_usage_logs(timestamp)');
  assert.deepEqual(repo.getGlobalTodayCounts(),expected);
  assert.match(sql, /:sqliteStart/, 'global query must include indexable lexical bounds');
  const plan=originalPrepare.call(db,'EXPLAIN QUERY PLAN '+sql).all(bound).map(r=>r.detail);
  for (const index of ['usage_ts_test','siwc_ts_test']) {
   const searches=plan.filter(detail=>detail.includes(`USING INDEX ${index}`));
   assert.equal(searches.length,2,plan.join('\n'));
   for (const detail of searches) assert.match(detail,/SEARCH .* \(timestamp>\? AND timestamp<\?\)/);
  }
 } finally {globalThis.Date=realDate;db.prepare=originalPrepare;}
});
test('authenticated admin stats match with and without optional timestamp indexes',async()=>{
 const {default:admin}=await import('../src/routes/admin.ts');
 const timestamp=new Date().toISOString();
 db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run('http-o','u','a',timestamp,'m','openai',0,0,1,0);
 db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('http-s','u','s',timestamp,'m','openai',0,0,0,1,0);
 const app=express();app.use('/admin',admin);const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const url=`http://127.0.0.1:${server.address().port}/admin/stats`;
  const read=async()=>{const response=await fetch(url,{headers:{authorization:`Bearer ${process.env.ADMIN_API_KEY}`}});assert.equal(response.status,200);const text=await response.text();assert.doesNotMatch(text,/credentials|api_key|secret/i);return JSON.parse(text).todayUsage;};
  db.exec('DROP INDEX usage_ts_test; DROP INDEX siwc_ts_test');const before=await read();
  db.exec('CREATE INDEX usage_ts_test ON usage_logs(timestamp); CREATE INDEX siwc_ts_test ON siwc_usage_logs(timestamp)');const after=await read();
  assert.deepEqual(before,{totalRequests:2,successRequests:1});assert.deepEqual(after,before);
 } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
