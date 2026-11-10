// Synthetic file-backed experiment only; creates and removes its own scratch directory.
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Incremental429,fixtureSchema,finitePageSql} from '../src/db/experimental-429-incremental.ts';
const dir=mkdtempSync(join(process.env.TMPDIR,'inc429-bench-'));
const db=new Database(join(dir,'synthetic.db'));
try {
  db.exec(fixtureSchema);
  const insert=db.prepare('INSERT INTO inc429_rows VALUES(?,?,?,?)');
  db.transaction(()=>{
    for (let i=1;i<=100000;i++) insert.run('upstream',String(i).padStart(6,'0'),i,i%100===0?1000000000:null);
    db.prepare('UPDATE inc429_meta SET counter=100000').run();
  }).immediate();
  const store=new Incremental429(db);
  const plan=db.prepare('EXPLAIN QUERY PLAN '+finitePageSql).all('','',10);
  const t=performance.now(); const page=store.page(10); const elapsed=performance.now()-t;
  console.log(JSON.stringify({rows:100000,finite:1000,pageSize:page.rows.length,elapsedMs:elapsed,plan}));
  if(page.rows.length!==10 || !JSON.stringify(plan).includes('inc429_finite')) throw Error('Unexpected benchmark result');
} finally {db.close();rmSync(dir,{recursive:true,force:true});}
