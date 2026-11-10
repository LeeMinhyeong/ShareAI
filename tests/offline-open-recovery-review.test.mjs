// ADR 0018 init fixture: inline startup children run db:init's provisioning first when the file is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

const script='scripts/offline-open-recovery.mjs';
const flags=['--routers-stopped','--provider-no-inflight','--backup-verified','--accept-unverified-remote-evidence'];
const id='12345678-1234-4123-8123-123456789abc';
const run=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000});
const init=file=>run('initialize-audit','--db',file,'--audit-never-provisioned',...flags);
const recoverArgs=(file,kind,account,actor,reason)=>['recover','--db',file,'--kind',kind,'--account-id',account,'--attempt-id',id,'--actor',actor,'--reason',reason,...flags];
const startup=file=>spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',"import {existsSync} from 'node:fs'; if(!existsSync(process.env.DATABASE_URL.slice(7))) await (await import('./tests/helpers/fresh-db.mjs')).provisionFromEnv(); import {initDatabase,closeDatabase} from './src/db/client.ts'; initDatabase(); closeDatabase()"],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'}});
async function bounded(promise,ms) { let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('child timeout')),ms);})]); } finally {clearTimeout(timer);} }

test('recovery followed by real application startup preserves cooldowns and exact audit',()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'recovery-restart-')),file=path.join(dir,'synthetic.db');
 try {
  let r=startup(file); assert.equal(r.status,0,r.stderr);
  let db=new Database(file); try {db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('account-1',id); db.prepare('INSERT INTO siwc_account_attempts VALUES (?,?)').run('siwc-1',id); db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('upstream','account-1',1799999990000,1800000060000,1); db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('siwc','siwc-1',1799999991000,1800000061000,2);} finally {db.close();}
  r=init(file); assert.equal(r.status,0,r.stderr);
  for(const args of [recoverArgs(file,'ordinary','account-1','operator-1','REMOTE_COMPLETED'),recoverArgs(file,'siwc','siwc-1','operator-2','REMOTE_NOT_STARTED')]) {r=run(...args); assert.equal(r.status,0,r.stderr);}
  r=startup(file); assert.equal(r.status,0,r.stderr);
  db=new Database(file,{readonly:true}); try {
   assert.equal(db.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n,0); assert.equal(db.prepare('SELECT count(*) n FROM siwc_account_attempts').get().n,0);
   assert.deepEqual(db.prepare('SELECT * FROM account_429_cooldowns ORDER BY kind').all(),[{kind:'siwc',account_id:'siwc-1',observed_at:1799999991000,until_at:1800000061000,revision:2},{kind:'upstream',account_id:'account-1',observed_at:1799999990000,until_at:1800000060000,revision:1}]);
   assert.deepEqual(db.prepare('SELECT kind,account_id,attempt_id,actor,reason,status FROM offline_open_recovery_audit ORDER BY id').all(),[{kind:'ordinary',account_id:'account-1',attempt_id:id,actor:'operator-1',reason:'REMOTE_COMPLETED',status:'CLEARED'},{kind:'siwc',account_id:'siwc-1',attempt_id:id,actor:'operator-2',reason:'REMOTE_NOT_STARTED',status:'CLEARED'}]);
  } finally {db.close();}
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('real-schema exact tuple refusals and injected audit failures preserve both fences',()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'recovery-exact-')),file=path.join(dir,'synthetic.db');
 try {
  let r=startup(file); assert.equal(r.status,0,r.stderr);
  let db=new Database(file); try {
   db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('shared',id);
   db.prepare('INSERT INTO siwc_account_attempts VALUES (?,?)').run('shared','12345678-1234-4123-8123-123456789abd');
   db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('upstream','shared',1799999990000,1800000060000,1);
   db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?,?,?)').run('siwc','shared',1799999991000,1800000061000,2);
  } finally {db.close();}
  r=init(file); assert.equal(r.status,0,r.stderr);
  db=new Database(file); try {
   db.prepare('INSERT INTO offline_open_recovery_audit VALUES (?,?,?,?,?,?,?,?)').run(1,'2026-01-01T00:00:00.000Z','siwc','previous','12345678-1234-4123-8123-123456789abe','synthetic-operator','REMOTE_COMPLETED','CLEARED');
  } finally {db.close();}
  const snapshot=()=>{const check=new Database(file,{readonly:true}); try {return {
   ordinary:check.prepare('SELECT * FROM ordinary_account_attempts').all(),
   siwc:check.prepare('SELECT * FROM siwc_account_attempts').all(),
   cooldowns:check.prepare('SELECT * FROM account_429_cooldowns ORDER BY kind,account_id').all(),
   restrictions:check.prepare('SELECT kind,account_id,duration_ms,generation FROM account_429_v2_restrictions ORDER BY kind,account_id').all(),
   audit:check.prepare('SELECT * FROM offline_open_recovery_audit').all(),
   journal:check.pragma('journal_mode',{simple:true})
  };} finally {check.close();}};
  const asOf=1800000000000;
  const probeSource=`
   import assert from 'node:assert/strict';
   import {getDb,closeDatabase} from './src/db/client.ts';
   import {AccountRepository} from './src/db/repositories/accounts.ts';
   import {AccountPoolManager} from './src/account-pool/manager.ts';
   import {SiwcStore} from './src/upstream/siwc-store.ts';
   import {CredentialVault} from './src/utils/encryption.ts';
   import {arm429V2} from './src/db/account-429-v2-store.ts';
   const db=getDb(); Date.now=()=>${asOf};
   if (process.env.FIXTURE_SETUP) {
    const account=new AccountRepository().create({name:'synthetic',provider:'openai',credentialType:'api_key',credentials:'synthetic'});
    db.prepare('UPDATE upstream_accounts SET id=? WHERE id=?').run('shared',account.id);
    db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('shared','synthetic'); INSERT INTO siwc_access_policy VALUES ('shared',1,'all'); INSERT INTO users (id,api_key_hash,name,email,tier,daily_limit) VALUES ('fixture-user','synthetic-hash','fixture','fixture@example.invalid','pro',100)");
    // ADR 0008: the durable shared cooldown the router reads is the v2 restriction.
    db.transaction(()=>{arm429V2(db,'upstream','shared',60000);arm429V2(db,'siwc','shared',61000);}).immediate();
    new SiwcStore(db,new CredentialVault()).create('shared',{issuer:'https://auth.openai.com',subject:'synthetic',clientId:'synthetic-client',accessToken:'synthetic',idToken:'synthetic',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:'2027-01-15T08:00:00.000Z'});
   } else {
    const seen={}; const prepare=db.prepare.bind(db);
    db.prepare=(sql)=>{const statement=prepare(sql); if(!sql.includes('account_429_v2_restrictions')) return statement;
     return new Proxy(statement,{get(target,key){if(key==='get') return (...args)=>{const row=target.get(...args); if(args[1]==='shared') seen[args[0]]={args,row}; return row;}; const value=target[key]; return typeof value==='function'?value.bind(target):value;}});};
    await new AccountPoolManager().selectCandidate('fixture-user','synthetic','openai','priority');
    for(const kind of ['upstream','siwc']) {assert.deepEqual(seen[kind]?.args,[kind,'shared']); assert.ok(seen[kind]?.row,kind+' reader did not see the active v2 restriction');}
   }
   closeDatabase();`;
  const probe=setup=>{const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',probeSource],{encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false',...(setup?{FIXTURE_SETUP:'1'}:{})}}); assert.equal(result.status,0,result.stderr);};
  probe(true);
  const before=snapshot();
  probe(false);
  { const check=new Database(file,{readonly:true}); try {
   for(const kind of ['upstream','siwc']) assert.ok(check.prepare('SELECT 1 FROM account_429_v2_restrictions WHERE kind=? AND account_id=?').get(kind,'shared'),`${kind} v2 restriction must be active`);
  } finally {check.close();} }
  assert.deepEqual(before.audit,[{id:1,happened_at:'2026-01-01T00:00:00.000Z',kind:'siwc',account_id:'previous',attempt_id:'12345678-1234-4123-8123-123456789abe',actor:'synthetic-operator',reason:'REMOTE_COMPLETED',status:'CLEARED'}]);
  {const check=new Database(file); try {
   assert.throws(()=>check.prepare("UPDATE offline_open_recovery_audit SET actor='changed' WHERE id=1").run(),/append only/);
   assert.throws(()=>check.prepare('DELETE FROM offline_open_recovery_audit WHERE id=1').run(),/append only/);
   assert.throws(()=>check.prepare('INSERT OR REPLACE INTO offline_open_recovery_audit VALUES (?,?,?,?,?,?,?,?)').run(...Object.values(before.audit[0])),/append only/);
  } finally {check.close();}}
  assert.deepEqual(snapshot(),before);
  assert.deepEqual(before.cooldowns,[{kind:'siwc',account_id:'shared',observed_at:1799999991000,until_at:1800000061000,revision:2},{kind:'upstream',account_id:'shared',observed_at:1799999990000,until_at:1800000060000,revision:1}]);
  // Each kind refuses a wrong account and the other kind's attempt ID.
  for(const [kind,wrongAttempt] of [['ordinary','12345678-1234-4123-8123-123456789abd'],['siwc',id]]) {
   for(const [account,attemptId] of [['other',kind==='ordinary'?id:'12345678-1234-4123-8123-123456789abd'],['shared',wrongAttempt]]) {
    const args=recoverArgs(file,kind,account,'operator','REMOTE_COMPLETED').map((v,i,a)=>a[i-1]==='--attempt-id'?attemptId:v);
    r=run(...args); assert.equal(r.status,1,r.stderr); assert.deepEqual(snapshot(),before);
   }
  }
  const preload=path.join(dir,'audit-fault.mjs');
  writeFileSync(preload,`import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))};
import assert from 'node:assert/strict';
const prepare=Database.prototype.prepare;
Database.prototype.prepare=function(sql,...args){
 if(sql.startsWith('INSERT INTO main.offline_open_recovery_audit')) {
  const kind=process.argv[process.argv.indexOf('--kind')+1];
  const other=kind==='ordinary'?'siwc':'ordinary';
  assert.equal(this.inTransaction,true);
  assert.deepEqual(prepare.call(this,'SELECT * FROM main.'+kind+'_account_attempts').all(),[]);
  assert.deepEqual(prepare.call(this,'SELECT * FROM main.'+other+'_account_attempts').all(),[{account_id:'shared',attempt_id:other==='ordinary'?${JSON.stringify(id)}:'12345678-1234-4123-8123-123456789abd'}]);
  console.error('AUDIT_FAULT_VERIFIED_'+kind);
  throw Error('synthetic audit fault');
 }
 return prepare.call(this,sql,...args);
};`);
  for(const [kind,attemptId] of [['ordinary',id],['siwc','12345678-1234-4123-8123-123456789abd']]) {
   const args=recoverArgs(file,kind,'shared','operator','REMOTE_COMPLETED').map((v,i,a)=>a[i-1]==='--attempt-id'?attemptId:v);
   r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,script,...args],{encoding:'utf8',timeout:10000});
   assert.equal(r.status,1,r.stderr); assert.match(r.stderr,new RegExp(`AUDIT_FAULT_VERIFIED_${kind}`)); assert.deepEqual(snapshot(),before); probe(false);
  }
  r=run(...recoverArgs(file,'ordinary','shared','operator','REMOTE_COMPLETED')); assert.equal(r.status,0,r.stderr);
  const after=snapshot(); assert.deepEqual(after.ordinary,[]); assert.deepEqual(after.siwc,before.siwc);
  assert.deepEqual(after.cooldowns,before.cooldowns); assert.equal(after.journal,before.journal);
  assert.equal(after.audit.length,2); assert.deepEqual(after.audit[0],before.audit[0]); const {kind,account_id,attempt_id,actor,reason,status}=after.audit[1]; assert.deepEqual({kind,account_id,attempt_id,actor,reason,status},{kind:'ordinary',account_id:'shared',attempt_id:id,actor:'operator',reason:'REMOTE_COMPLETED',status:'CLEARED'});
  const siwcArgs=recoverArgs(file,'siwc','shared','operator','REMOTE_NOT_STARTED').map((v,i,a)=>a[i-1]==='--attempt-id'?'12345678-1234-4123-8123-123456789abd':v);
  r=run(...siwcArgs); assert.equal(r.status,0,r.stderr);
  const final=snapshot(); assert.deepEqual(final.ordinary,[]); assert.deepEqual(final.siwc,[]);
  assert.deepEqual(final.cooldowns,before.cooldowns); assert.equal(final.journal,before.journal);
  assert.equal(final.audit.length,3); assert.deepEqual(final.audit.slice(0,2),after.audit);
  const second=final.audit[2]; assert.deepEqual({kind:second.kind,account_id:second.account_id,attempt_id:second.attempt_id,actor:second.actor,reason:second.reason,status:second.status},{kind:'siwc',account_id:'shared',attempt_id:'12345678-1234-4123-8123-123456789abd',actor:'operator',reason:'REMOTE_NOT_STARTED',status:'CLEARED'});
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('refused audit initialization leaves journal mode unchanged',()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'recovery-journal-')),file=path.join(dir,'synthetic.db');
 try {let db=new Database(file); db.pragma('journal_mode = DELETE'); db.exec('CREATE TABLE ordinary_account_attempts (bad TEXT)'); const before=db.pragma('journal_mode',{simple:true}); db.close(); assert.notEqual(init(file).status,0); db=new Database(file,{readonly:true}); try {assert.equal(db.pragma('journal_mode',{simple:true}),before);} finally {db.close();} assert.notEqual(startup(file).status,0); db=new Database(file,{readonly:true}); try {assert.equal(db.pragma('journal_mode',{simple:true}),before);} finally {db.close();}} finally {rmSync(dir,{recursive:true,force:true});}
});

test('a competing recovery observes SQLITE_BUSY while first holds writer after deletion',async()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'recovery-busy-')),file=path.join(dir,'synthetic.db'); let children=[];
 try {
  let r=startup(file); assert.equal(r.status,0,r.stderr); const db=new Database(file); db.prepare('INSERT INTO ordinary_account_attempts VALUES (?,?)').run('account-1',id); db.close(); r=init(file); assert.equal(r.status,0,r.stderr);
  const preload=path.join(dir,'instrument.mjs'),ready=path.join(dir,'ready'),release=path.join(dir,'release'),busy=path.join(dir,'busy');
  writeFileSync(preload,`import Database from ${JSON.stringify(import.meta.resolve('better-sqlite3'))}; import {writeFileSync,existsSync} from 'node:fs'; const prepare=Database.prototype.prepare; Database.prototype.prepare=function(sql,...args){ if(process.env.FIRST && sql.startsWith('INSERT INTO main.offline_open_recovery_audit')) { writeFileSync(process.env.READY,'deleted'); const end=Date.now()+15000; while(!existsSync(process.env.RELEASE)){if(Date.now()>end) throw Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);} } return prepare.call(this,sql,...args); }; const transaction=Database.prototype.transaction; Database.prototype.transaction=function(...args){const tx=transaction.apply(this,args); return {immediate:(...a)=>{try{return tx.immediate(...a)}catch(e){if(process.env.SECOND) writeFileSync(process.env.BUSY,e.code||'unknown'); throw e}},deferred:(...a)=>tx.deferred(...a)};};`);
  const args=['--import',pathToFileURL(preload).href,script,...recoverArgs(file,'ordinary','account-1','operator','REMOTE_COMPLETED')];
  const launch=extra=>{const c=spawn(process.execPath,args,{env:{...process.env,READY:ready,RELEASE:release,BUSY:busy,...extra},stdio:'ignore'}); children.push(c); return {child:c,exit:new Promise((resolve,reject)=>{c.once('error',reject); c.once('exit',(code,signal)=>resolve({code,signal}));})};};
  const first=launch({FIRST:'1'}); const deadline=Date.now()+10000; while(!existsSync(ready)){if(first.child.exitCode!==null) throw Error('first exited before barrier'); if(Date.now()>deadline) throw Error('first barrier timeout'); await new Promise(r=>setTimeout(r,20));}
  const second=launch({SECOND:'1'}); const outcome=await bounded(second.exit,8000); assert.notEqual(outcome.code,0); assert.equal((await import('node:fs')).readFileSync(busy,'utf8'),'SQLITE_BUSY');
  writeFileSync(release,'go'); assert.equal((await bounded(first.exit,8000)).code,0);
  const check=new Database(file,{readonly:true}); try {assert.equal(check.prepare('SELECT count(*) n FROM ordinary_account_attempts').get().n,0); assert.equal(check.prepare('SELECT count(*) n FROM offline_open_recovery_audit').get().n,1);} finally {check.close();}
 } finally {for(const c of children) if(c.exitCode===null && c.signalCode===null) c.kill(); await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?Promise.resolve():new Promise(r=>c.once('exit',r)))); rmSync(dir,{recursive:true,force:true});}
});
