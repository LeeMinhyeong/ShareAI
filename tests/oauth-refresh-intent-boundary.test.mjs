import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'oauth-boundary-'));
const file=path.join(dir,'db.sqlite');
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {resolveAuth}=await import('../src/upstream/tokens.ts');
const {logger}=await import('../src/utils/logger.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(), repo=new AccountRepository(), proto=Object.getPrototypeOf(db);
const worker=fileURLToPath(new URL('./phase4-intent-fence-worker.mjs',import.meta.url));
const make=(name)=>repo.create({name,provider:'openai',credentialType:'oauth',credentials:JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:name,expiresAt:1})});
const intentCount=(id)=>db.prepare('SELECT count(*) n FROM oauth_refresh_intents WHERE account_id=?').get(id).n;
function otherClaim(id){return spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker,file,id],{env:process.env,encoding:'utf8',timeout:10000});}
after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});

test('committed claim fences another process before abort cleanup, then permits one refresh', {timeout:15000},async()=>{
 const a=make('boundary-cross-process'), controller=new AbortController(), oldExec=proto.exec, oldFetch=globalThis.fetch;
 let observed=false, competing, calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({access_token:'new',refresh_token:'rotated',expires_in:3600}));};
 proto.exec=function(sql){const result=oldExec.call(this,sql);if(sql==='COMMIT'&&!observed&&this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){observed=true;queueMicrotask(()=>{competing=otherClaim(a.id);controller.abort();});}return result;};
 try{
  await assert.rejects(resolveAuth(a,{signal:controller.signal}));
  await new Promise(r=>setImmediate(r));
  assert.equal(observed,true);assert.equal(competing.status,1,competing.stderr);assert.match(competing.stderr,/reauthentication required/);
  assert.equal(calls,0);assert.equal(intentCount(a.id),0,'known-unused committed intent must be released');
  assert.equal((await resolveAuth(repo.findById(a.id))).token,'new');assert.equal(calls,1);
 }finally{proto.exec=oldExec;globalThis.fetch=oldFetch;}
});

test('unknown commit outcome remains fenced even when provider was never called', {timeout:15000},async()=>{
 const a=make('unknown-commit'), oldExec=proto.exec, oldFetch=globalThis.fetch;let injected=false,calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('unexpected provider');};
 proto.exec=function(sql){const result=oldExec.call(this,sql);if(sql==='COMMIT'&&!injected&&this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){injected=true;throw Error('injected unknown commit outcome');}return result;};
 try{
  await assert.rejects(resolveAuth(a),/injected unknown commit outcome/);assert.equal(injected,true);assert.equal(intentCount(a.id),1);assert.equal(calls,0);
  const competing=otherClaim(a.id);assert.equal(competing.status,1,competing.stderr);assert.match(competing.stderr,/reauthentication required/);
  await assert.rejects(resolveAuth(repo.findById(a.id)),/reauthentication required/);assert.equal(calls,0);
 }finally{proto.exec=oldExec;globalThis.fetch=oldFetch;}
});

test('cleanup failure retains fence and prevents another process from replaying', {timeout:15000},async()=>{
 const a=make('cleanup-failure'), controller=new AbortController(), oldExec=proto.exec, oldFetch=globalThis.fetch;
 let observed=false,failed=false,calls=0,reported=false;const oldError=logger.error;
 logger.error=(...args)=>{if(args.some(x=>typeof x==='string'&&x.includes('unused OAuth refresh intent')))reported=true;};
 globalThis.fetch=async()=>{calls++;throw Error('unexpected provider');};
 proto.exec=function(sql){
  if(sql==='BEGIN IMMEDIATE'&&observed&&!failed){failed=true;throw Error('injected cleanup failure');}
  const result=oldExec.call(this,sql);
  if(sql==='COMMIT'&&!observed&&this.prepare('SELECT 1 FROM oauth_refresh_intents WHERE account_id=?').get(a.id)){observed=true;queueMicrotask(()=>controller.abort());}
  return result;
 };
 try{
  await assert.rejects(resolveAuth(a,{signal:controller.signal}));await new Promise(r=>setImmediate(r));
  assert.equal(failed,true);assert.equal(intentCount(a.id),1);assert.equal(calls,0);assert.equal(reported,true,'cleanup failure must be reported');
  const competing=otherClaim(a.id);assert.equal(competing.status,1,competing.stderr);assert.match(competing.stderr,/reauthentication required/);
 }finally{proto.exec=oldExec;globalThis.fetch=oldFetch;logger.error=oldError;}
});

test('unused release cannot delete another attempt or a replaced generation',()=>{
 const a=make('ownership');const intent=repo.claimRefresh(a.id,a.credentials,db,a.credentialRevision);
 repo.releaseUnusedRefresh(a.id,intent.credentialVersion,a.credentialRevision,intent.fingerprint,'wrong-attempt',db);assert.equal(intentCount(a.id),1);
 db.prepare('UPDATE upstream_accounts SET credentials=credentials WHERE id=?').run(a.id);
 repo.releaseUnusedRefresh(a.id,intent.credentialVersion,a.credentialRevision,intent.fingerprint,intent.attemptId,db);assert.equal(intentCount(a.id),1);
});
