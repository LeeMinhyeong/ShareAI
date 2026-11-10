// Synthetic in-memory benchmark only; never opens a production database.
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';process.env.DATABASE_URL='sqlite::memory:';process.env.ENCRYPTION_KEY='a'.repeat(64);process.env.ADMIN_API_KEY='x'.repeat(20);process.env.LOG_LEVEL='error';process.env.LOG_PRETTY='false';
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {UsageLogRepository}=await import('../src/db/repositories/usage-logs.ts');
const db=getDb();db.pragma('foreign_keys = OFF');
const a=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
const b=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
const RealDate=Date, now=RealDate.parse('2024-03-10T12:00:00.000Z');
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
db.transaction(()=>{for(let i=0;i<100000;i++){const t=new RealDate(now-(i%10)*86400000-(i%86400)*1000).toISOString();const timestamp=Math.floor(i/10)%2?t:t.slice(0,19).replace('T',' ');if(i%2)a.run('a'+i,'u','a',timestamp,'m','openai',0,0,i%3?1:0,0);else b.run('b'+i,'u','s',timestamp,'m','openai',0,0,i%3?1:0,0,0);}})();
const repo=new UsageLogRepository();const size=()=>db.pragma('page_count',{simple:true})*db.pragma('page_size',{simple:true});
const sample=fn=>{fn();const samples=[];let result;for(let i=0;i<11;i++){const t=performance.now();result=fn();samples.push(performance.now()-t);}samples.sort((a,b)=>a-b);return {medianMs:samples[5],result};};
repo.getGlobalTodayCounts();const old=db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS successful FROM (SELECT timestamp,success FROM usage_logs UNION ALL SELECT timestamp,success FROM siwc_usage_logs) WHERE usage_utc_ms(timestamp) BETWEEN ? AND ?');
const start=RealDate.parse('2024-03-10T00:00:00.000Z');const beforeBytes=size(),baseline=sample(()=>old.get(start,now)),before=sample(()=>repo.getGlobalTodayCounts());const t=performance.now();db.exec('CREATE INDEX usage_ts_bench ON usage_logs(timestamp); CREATE INDEX siwc_ts_bench ON siwc_usage_logs(timestamp)');const buildMs=performance.now()-t;const afterBytes=size(),after=sample(()=>repo.getGlobalTodayCounts());
const buckets=db.prepare('SELECT substr(timestamp,1,10) AS day, count(*) AS rows FROM (SELECT timestamp FROM usage_logs UNION ALL SELECT timestamp FROM siwc_usage_logs) GROUP BY day ORDER BY day').all();
const expected={totalRequests:baseline.result.total,successRequests:baseline.result.successful ?? 0};
assert.deepEqual(before.result,expected);assert.deepEqual(after.result,expected);
console.log(JSON.stringify({rows:buckets.reduce((sum,b)=>sum+b.rows,0),days:buckets.length,buckets,samples:11,warmups:1,baseline,before,after,buildMs,beforeBytes,afterBytes},null,2));closeDatabase();
