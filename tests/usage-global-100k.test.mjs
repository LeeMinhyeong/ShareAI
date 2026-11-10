import {test} from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV='test'; process.env.DATABASE_URL='sqlite::memory:';
process.env.ENCRYPTION_KEY='a'.repeat(64); process.env.ADMIN_API_KEY='x'.repeat(20);
process.env.LOG_LEVEL='error'; process.env.LOG_PRETTY='false';
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {UsageLogRepository}=await import('../src/db/repositories/usage-logs.ts');
const {parseUsageUtc}=await import('../src/db/usage-utc.ts');

test('100k mixed timestamps match strict full scan at UTC boundaries with and without indexes',()=>{
 const db=getDb(); db.pragma('foreign_keys = OFF');
 const a=db.prepare('INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const b=db.prepare('INSERT INTO siwc_usage_logs(id,user_id,account_id,timestamp,model,provider,input_tokens,output_tokens,success,aborted,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 const RealDate=Date, day=RealDate.parse('2024-03-10T00:00:00.000Z');
 const edge=['2024-03-10 00:00:00','2024-03-10T00:00:00.000Z','2024-03-10 09:00:00','2024-03-10T09:00:00.999Z','2024-03-10T09:00:01.000Z','2024-03-10 09:00:01','2024-03-10T08:99:00.000Z','2024-03-10T08:00:00.000+00:00','2024-03-10 08:00:00Z','2024-03-09T23:59:59.999Z','2024-03-11T00:00:00.000Z','2024-02-30T08:00:00.000Z'];
 db.transaction(()=>{for(let i=0;i<50000;i++){
  const iso=new RealDate(day + ((i*7919)%259200)*1000 - 86400000 + (i%1000)).toISOString();
  // Insert every special boundary into each table with both success values.
  const t=i<edge.length*2 ? edge[Math.floor(i/2)] : (Math.floor(i/2)%2 ? iso : iso.slice(0,19).replace('T',' '));
  a.run('a'+i,'u','a',t,'m','p',0,0,i%2,0);
  b.run('b'+i,'u','s',t,'m','p',0,0,i%2,i%3===0?1:0,0);
 }})();
 assert.equal(db.prepare('SELECT (SELECT count(*) FROM usage_logs)+(SELECT count(*) FROM siwc_usage_logs) AS n').get().n,100000);
 const coverage=new Map(), boundaries=new Set(edge);
 for(const row of db.prepare("SELECT timestamp,success,'ordinary' AS kind FROM usage_logs UNION ALL SELECT timestamp,success,'siwc' AS kind FROM siwc_usage_logs").iterate()) {
  if(boundaries.has(row.timestamp)) {
   const key=JSON.stringify([row.timestamp,row.success,row.kind]);
   coverage.set(key,(coverage.get(key)??0)+1);
  }
 }
 for(const timestamp of edge) for(const success of [0,1]) for(const kind of ['ordinary','siwc']) {
  assert.ok(coverage.get(JSON.stringify([timestamp,success,kind]))>0,`missing boundary=${timestamp} success=${success} kind=${kind}`);
 }
 db.function('reference_utc_ms',{deterministic:true},parseUsageUtc);
 const reference=db.prepare('SELECT COUNT(*) AS totalRequests, COALESCE(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END),0) AS successRequests FROM (SELECT timestamp,success FROM usage_logs UNION ALL SELECT timestamp,success FROM siwc_usage_logs) WHERE reference_utc_ms(timestamp) BETWEEN ? AND ?');
 const repo=new UsageLogRepository();
 const originalPrepare=db.prepare; let sql,bound;
 db.prepare=function(text,...args){const stmt=originalPrepare.call(this,text,...args);if(text.includes('COUNT(*) AS total')&&text.includes('siwc_usage_logs')){sql=text;return {get(params){bound=params;return stmt.get(params);}};}return stmt;};
 try {
  for (const indexed of [false,true]) {
   if(indexed) db.exec('CREATE INDEX usage_ts_100k ON usage_logs(timestamp); CREATE INDEX siwc_ts_100k ON siwc_usage_logs(timestamp)');
   for (const now of [day,day+9*3600000+999,day+86399999]) {
    globalThis.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} };
    assert.deepEqual(repo.getGlobalTodayCounts(),reference.get(day,now),`indexed=${indexed} asOf=${new RealDate(now).toISOString()}`);
    const iso=new RealDate(now).toISOString();
    assert.equal(bound.isoEnd,iso);
    assert.equal(bound.sqliteEnd,iso.slice(0,19).replace('T',' '));
    if(indexed) {
     const plan=originalPrepare.call(db,'EXPLAIN QUERY PLAN '+sql).all(bound).map(row=>row.detail);
     for(const index of ['usage_ts_100k','siwc_ts_100k']) {
      const searches=plan.filter(detail=>detail.includes(`USING INDEX ${index}`));
      assert.equal(searches.length,2,plan.join('\n'));
      for(const detail of searches) assert.match(detail,/SEARCH .* \(timestamp>\? AND timestamp<\?\)/);
     }
    }
   }
  }
 } finally { globalThis.Date=RealDate; db.prepare=originalPrepare; closeDatabase(); }
});
