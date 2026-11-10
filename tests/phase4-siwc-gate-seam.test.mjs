import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {migrateLedger,openAttempt,dispatchOpenAttemptOnce} from '../src/db/durable-ledger-foundation.ts';
import {spawnSync} from 'node:child_process';
const importDir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-gate-import-'));
Object.assign(process.env,{DATABASE_URL:`sqlite:${path.join(importDir,'unused.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),NODE_ENV:'test',LOG_LEVEL:'error'});
test.after(()=>rmSync(importDir,{recursive:true,force:true}));
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {assertSiwcDispatchGate}=await import('../src/upstream/forward-chat.ts');

test('coordinator supplies its locked writer to the synchronous gate', async () => {
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-gate-')), file=path.join(dir,'db.sqlite');
 const db=new Database(file);
 try { migrateLedger(db); assert.equal(openAttempt(db,'a'),true); let started=0;
   await dispatchOpenAttemptOnce(file,'a',writer=>{assert.ok(writer?.inTransaction); assert.equal(writer.prepare("SELECT state FROM phase4_experimental_ledger_attempts WHERE id='a'").get().state,'OPEN');},()=>{started++;return Promise.resolve('ok');});
   assert.equal(started,1);
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('rejected async gate never starts and permanently consumes claim',async()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-async-gate-')),file=path.join(dir,'db.sqlite'),db=new Database(file);let started=0;
 try {migrateLedger(db);openAttempt(db,'a');await assert.rejects(dispatchOpenAttemptOnce(file,'a',()=>Promise.reject(new Error('late rejection')),()=>{started++;return Promise.resolve();}),/gate must be synchronous/);
  await assert.rejects(dispatchOpenAttemptOnce(file,'a',()=>{},()=>{started++;return Promise.resolve();}));assert.equal(started,0);assert.equal(db.prepare('SELECT count(*) n FROM phase4_experimental_ledger_dispatch_claims').get().n,1);assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts').get().state,'OPEN');
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('real SIWC gate is protected from another process and rolls back nested revocation', {timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(process.env.TMPDIR,'siwc-lock-gate-')),file=path.join(dir,'db.sqlite'),db=new Database(file);let started=0;
 try {db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE siwc_access_policy(account_id TEXT,enabled INTEGER,scope TEXT); CREATE TABLE siwc_access_users(account_id TEXT,user_id TEXT); CREATE TABLE users(id TEXT,enabled INTEGER); INSERT INTO users VALUES('u',1); INSERT INTO siwc_accounts VALUES('a','a'); INSERT INTO siwc_access_policy VALUES('a',1,'all')");
  const store=new SiwcStore(db,new CredentialVault());store.create('a',{issuer:'https://auth.openai.com',subject:'s',clientId:'client',accessToken:'synthetic',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});const snapshot=store.readSnapshot('a');const signal=new AbortController().signal;migrateLedger(db);openAttempt(db,'a');
  await assert.rejects(dispatchOpenAttemptOnce(file,'a',writer=>{
   const child=spawnSync(process.execPath,['-e',"const D=require('better-sqlite3');const d=new D(process.argv[1],{timeout:0});try{d.prepare('UPDATE siwc_access_policy SET enabled=0').run();process.exit(2)}catch(e){if(e.code!=='SQLITE_BUSY') {console.error(e);process.exit(3)}process.exit(0)}",file],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.equal(writer.prepare('SELECT enabled FROM siwc_access_policy').get().enabled,1);
   writer.transaction(()=>writer.prepare('UPDATE siwc_access_policy SET enabled=0').run())();assertSiwcDispatchGate(writer,'u','a',snapshot,signal);
  },()=>{started++;return Promise.resolve();}),e=>e.status===404);
  assert.equal(started,0);assert.equal(db.prepare('SELECT enabled FROM siwc_access_policy').get().enabled,1);assert.equal(db.prepare('SELECT count(*) n FROM phase4_experimental_ledger_dispatch_claims').get().n,1);assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts').get().state,'OPEN');
  await assert.rejects(dispatchOpenAttemptOnce(file,'a',()=>{},()=>{started++;return Promise.resolve();}));assert.equal(started,0);
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
