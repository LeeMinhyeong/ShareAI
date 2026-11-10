import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
const dir=mkdtempSync(path.join(process.env.TMPDIR,'oauth-contention-'));
const file=path.join(dir,'router.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {resolveAuth,drainTokenRefreshes}=await import('../src/upstream/tokens.ts');
const {default:Database}=await import('better-sqlite3');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
getDb();const repo=new AccountRepository();
const account=(name)=>repo.create({name,provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:name,expiresAt:Date.now()-1})});
after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});
test('refresh claim does not block the event loop under a process write lock', {timeout:12000},async()=>{
 const a=account('lock');const child=fork(new URL('./phase4-result-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
 const orig=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600}));
 try {await once(child,'message');const start=performance.now();const pending=resolveAuth(a);pending.catch(()=>{});await new Promise(r=>setTimeout(r,100));assert.ok(performance.now()-start<1000,'refresh claim blocked the event loop');child.send('release');await once(child,'exit');await pending;}
 finally {globalThis.fetch=orig;if(child.connected)child.send('release');if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');}
});
test('aborted waiter leaves shared provider rotation to persist for another waiter', {timeout:5000},async()=>{
 const a=account('shared');let release,entered;const gate=new Promise(r=>release=r),barrier=new Promise(r=>entered=r);const orig=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;entered();await gate;return new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600}));};
 try {const controller=new AbortController();const first=resolveAuth(a,{signal:controller.signal});first.catch(()=>{});await barrier;const second=resolveAuth(a);controller.abort();await assert.rejects(first);release();assert.equal((await second).token,'new');assert.equal(calls,1);assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'rotated');} finally {release();globalThis.fetch=orig;}
});
for (const outcome of ['success','failure']) test(`refresh ${outcome} persistence yields to the event loop during a process write lock`, {timeout:7000},async()=>{
 const a=account(`persist-${outcome}`);let child;let locked;const barrier=new Promise(r=>locked=r);const orig=globalThis.fetch;
 globalThis.fetch=async()=>{child=fork(new URL('./phase4-result-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});await once(child,'message');locked();return outcome==='success' ? new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600})) : new Response('',{status:500});};
 try {const pending=resolveAuth(a);pending.catch(()=>{});await barrier;const start=performance.now();await new Promise(r=>setTimeout(r,100));assert.ok(performance.now()-start<1000,'refresh persistence blocked the event loop');child.send('release');await once(child,'exit');if(outcome==='success'){await pending;assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'rotated');}else{await assert.rejects(pending);assert.equal(repo.findById(a.id).status,'error');}}
 finally {globalThis.fetch=orig;if(child?.connected)child.send('release');if(child&&child.exitCode===null&&child.signalCode===null)await once(child,'exit');}
});
test('last waiter abort after claim commit leaves unused token available for a later refresh', {timeout:5000},async()=>{
 const a=account('commit-abort');const controller=new AbortController();const oldFetch=globalThis.fetch;const db=getDb();const proto=Object.getPrototypeOf(db);const oldExec=proto.exec;let calls=0,observedCommit=false;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600}));};
 proto.exec=function(sql){const result=oldExec.call(this,sql);if(sql==='COMMIT' && !observedCommit && this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){observedCommit=true;queueMicrotask(()=>controller.abort());}return result;};
 try {await assert.rejects(resolveAuth(a,{signal:controller.signal}));assert.equal(observedCommit,true,'claim committed before abort');await new Promise(r=>setImmediate(r));assert.equal(calls,0,'abort precedes provider invocation');assert.equal((await resolveAuth(repo.findById(a.id))).token,'new');assert.equal(calls,1);}
 finally {proto.exec=oldExec;globalThis.fetch=oldFetch;}
});
test('same credential replacement before cleanup retains the intent fence', {timeout:5000},async()=>{
 const a=account('reauth-same');const controller=new AbortController();const oldFetch=globalThis.fetch;const db=getDb();const proto=Object.getPrototypeOf(db);const oldExec=proto.exec;let calls=0,observedCommit=false;
 globalThis.fetch=async()=>{calls++;throw Error('unexpected provider');};
 proto.exec=function(sql){const result=oldExec.call(this,sql);if(sql==='COMMIT' && !observedCommit && this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){observedCommit=true;queueMicrotask(()=>{db.prepare('UPDATE upstream_accounts SET credentials=credentials WHERE id=?').run(a.id);controller.abort();});}return result;};
 try {await assert.rejects(resolveAuth(a,{signal:controller.signal}));await new Promise(r=>setImmediate(r));assert.equal(observedCommit,true);assert.equal(repo.findById(a.id).credentialRevision,a.credentialRevision+1);assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents WHERE account_id=?').get(a.id).n,1);await assert.rejects(resolveAuth(repo.findById(a.id)),/reauthentication required/);assert.equal(calls,0);}
 finally {proto.exec=oldExec;globalThis.fetch=oldFetch;}
});
test('one waiter aborting at claim commit does not cancel another waiter', {timeout:5000},async()=>{
 const a=account('commit-shared');const controller=new AbortController();const oldFetch=globalThis.fetch;const db=getDb();const proto=Object.getPrototypeOf(db);const oldExec=proto.exec;let calls=0,observedCommit=false;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600}));};
 proto.exec=function(sql){const result=oldExec.call(this,sql);if(sql==='COMMIT' && !observedCommit && this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){observedCommit=true;queueMicrotask(()=>controller.abort());}return result;};
 try {const first=resolveAuth(a,{signal:controller.signal});const second=resolveAuth(a);await assert.rejects(first);assert.equal((await second).token,'new');assert.equal(observedCommit,true);assert.equal(calls,1);}
 finally {proto.exec=oldExec;globalThis.fetch=oldFetch;}
});
test('abort while waiting for claim does not consume the token', {timeout:7000},async()=>{
 const a=account('cancel-claim');const child=fork(new URL('./phase4-result-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});const orig=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};
 try {await once(child,'message');const controller=new AbortController();const p=resolveAuth(a,{signal:controller.signal});await new Promise(r=>setTimeout(r,100));controller.abort();await assert.rejects(p);child.send('release');await once(child,'exit');assert.equal(calls,0);assert.equal(getDb().prepare('SELECT count(*) n FROM oauth_refresh_intents WHERE account_id=?').get(a.id).n,0);}
 finally {globalThis.fetch=orig;if(child.connected)child.send('release');if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');}
});
test('shutdown drains canceled claim cleanup before closing the database', {timeout:5000},async()=>{
 const a=account('drain-cleanup');const controller=new AbortController();const db=getDb();const proto=Object.getPrototypeOf(db);const oldExec=proto.exec,oldFetch=globalThis.fetch;let lock,observedCommit=false,drained=false,calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('unexpected provider');};
 proto.exec=function(sql){const result=oldExec.call(this,sql);if(sql==='COMMIT'&&!observedCommit&&this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){observedCommit=true;queueMicrotask(()=>{lock=new Database(file,{timeout:0});lock.exec('BEGIN IMMEDIATE');controller.abort();});}return result;};
 try {await assert.rejects(resolveAuth(a,{signal:controller.signal}));const draining=drainTokenRefreshes().then(()=>{drained=true;});await new Promise(r=>setTimeout(r,60));assert.equal(drained,false);lock.exec('ROLLBACK');lock.close();lock=undefined;await draining;assert.equal(calls,0);assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents WHERE account_id=?').get(a.id).n,0);}
 finally {if(lock){lock.exec('ROLLBACK');lock.close();}proto.exec=oldExec;globalThis.fetch=oldFetch;}
});
