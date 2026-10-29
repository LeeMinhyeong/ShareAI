import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQL_SCHEMA } from '../src/db/schema.ts';

const worker = `
const {initDatabase,closeDatabase}=await import('./src/db/client.ts');
const {UserRepository}=await import('./src/db/repositories/users.ts');
initDatabase();
const r=new UserRepository().reserveDailyQuota('fixture-hash');
console.log(JSON.stringify({allowed:r.allowed,used:r.used}));
closeDatabase();
`;
function environment(file) { return { ...process.env, NODE_ENV:'test', DATABASE_URL:'sqlite:'+file, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'test-admin-key-'.repeat(3), LOG_LEVEL:'error', LOG_PRETTY:'false' }; }
function run(file) { return new Promise((resolve,reject) => {
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',worker], {env:environment(file)});
  let out='',err=''; child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>err+=b);
  child.on('error',reject); child.on('close',code=>code===0 ? resolve(JSON.parse(out.trim())) : reject(new Error(`worker ${code}: ${err} ${out}`)));
}); }

test('legacy UTC accounting, restart and multi-process reservation are atomic', async () => {
  const dir=mkdtempSync(path.join(process.env.TMPDIR, 'quota-')); const file=path.join(dir,'fixture.db');
  try {
    const db=new Database(file); db.exec(SQL_SCHEMA);
    db.prepare("INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit) VALUES ('u','fixture-hash','fixture','fixture@test.invalid','free',3)").run();
    db.prepare("INSERT INTO upstream_accounts (id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES ('a','fixture','openai','api_key','fixture','active','2099-01-01')").run();
    const insert=db.prepare("INSERT INTO usage_logs (id,user_id,upstream_account_id,timestamp,model,provider,success,latency_ms) VALUES (?, 'u','a',?,'test','openai',?,1)");
    const today=new Date().toISOString().slice(0,10); insert.run('legacy',today+'T00:00:00.000Z',1); insert.run('failed',today+'T00:00:01.000Z',0); insert.run('older','2020-01-01T23:59:59.000Z',1);
    db.close();
    const initial=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',worker],{env:environment(file),encoding:'utf8'});
    assert.equal(initial.status,0,initial.stderr); assert.deepEqual(JSON.parse(initial.stdout.trim()),{allowed:true,used:2});
    const results=await Promise.all(Array.from({length:8},()=>run(file)));
    assert.equal(results.filter(r=>r.allowed).length,1);
    const verify=new Database(file); assert.equal(verify.prepare('SELECT used FROM user_daily_quota WHERE user_id=? AND day=?').get('u',today).used,3);
    assert.equal(verify.prepare("SELECT used FROM user_daily_quota WHERE user_id='u' AND day='2020-01-01'").get().used,1);
    assert.throws(()=>verify.prepare("DELETE FROM users WHERE id='u'").run(),/usage history/);
    verify.prepare("UPDATE users SET daily_limit=4 WHERE id='u'").run(); verify.close();
    const crash=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',worker.replace('console.log(JSON.stringify({allowed:r.allowed,used:r.used}));','if (!r.allowed) process.exit(24); process.exit(23);')],{env:environment(file),encoding:'utf8'});
    assert.equal(crash.status,23,crash.stderr);
    const afterCrash=new Database(file); assert.equal(afterCrash.prepare('SELECT used FROM user_daily_quota WHERE user_id=? AND day=?').get('u',today).used,4); afterCrash.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
