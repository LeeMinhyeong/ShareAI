import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
const vault={encrypt:v=>v,decrypt:v=>v};
test('request-side store construction does not initialize schema or wait for writer', {timeout:5000}, async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR,'siwc-ctor-')), file=join(dir,'db.sqlite');
  const db=new Database(file,{timeout:5000}); new SiwcStore(db,vault);
  const child=fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
  try { await once(child,'message'); const start=Date.now(); new SiwcStore(db,vault,{initialize:false}); const elapsed=Date.now()-start; assert.ok(elapsed<200,`constructor blocked ${elapsed}ms`); }
  finally { if (child.exitCode===null && child.signalCode===null) { child.kill(); await once(child,'exit'); } db.close(); rmSync(dir,{recursive:true,force:true}); }
});
