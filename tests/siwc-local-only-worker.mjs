// Disposable worker: all configuration and persistent state belong to its parent.
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {responseStream} from './phase4-protocol-fixtures.mjs';
import path from 'node:path';
import {lstatSync,readFileSync} from 'node:fs';
import {listenFixture} from './siwc-local-only-listen.mjs';
import {cleanupFixture,closeFixtureServer} from './siwc-local-only-cleanup.mjs';

const file = process.argv[2];
// This is an accidental-use boundary, not protection against filesystem races.
try {
  const root=process.env.SIWC_FIXTURE_ROOT, token=process.env.SIWC_FIXTURE_OWNER;
  if(!root || !path.isAbsolute(root) || !file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(token || '')) throw 0;
  const dir=path.dirname(file), marker=path.join(dir,'.siwc-fixture-owner');
  if(path.dirname(dir)!==path.resolve(root) || !path.basename(dir).startsWith('siwc-local-only-') || path.basename(file)!=='fixture.sqlite') throw 0;
  if(!lstatSync(root).isDirectory() || !lstatSync(dir).isDirectory() || !lstatSync(marker).isFile() || readFileSync(marker,'utf8')!==token) throw 0;
  try { lstatSync(file); throw 0; } catch(e) { if(e?.code!=='ENOENT') throw e; }
} catch {
  console.error('SIWC fixture validation failed');
  process.exit(1);
}
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false', PORT:'1', HOST:'127.0.0.1'});
const bounded = (p, label) => { let t; return Promise.race([p, new Promise((_, reject) => { t=setTimeout(() => reject(new Error(`${label} timed out`)), 8000); })]).finally(() => clearTimeout(t)); };
const {getDb,closeDatabase} = await import('../src/db/client.ts');
const {CredentialVault,hashApiKey} = await import('../src/utils/encryption.ts');
const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {accountPool} = await import('../src/account-pool/manager.ts');
// The production client never creates a database; provision this owned fixture file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
let provider, server;
const requests = new Set();
const nativeFetch = globalThis.fetch;
const originalListen = express.application.listen;
const select = accountPool.selectCandidate;
const cooling = accountPool.siwcCooling;
const exec = Database.prototype.exec;
const prepare = Database.prototype.prepare;
let primaryFailed=false, primary;
try {
  const db = getDb(), users = new UserRepository();
  db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES('a','A'),('b','B'); INSERT INTO siwc_access_policy VALUES('a',1,'all'),('b',1,'all');");
  const user=users.create({apiKeyHash:hashApiKey('fixture-key'),name:'u',email:'u@example.invalid',tier:'pro',dailyLimit:100});
  const store=new SiwcStore(db,new CredentialVault());
  for(const id of ['a','b']) store.create(id,{issuer:'https://auth.openai.com',subject:id,clientId:id,accessToken:`token-${id}`,idToken:'fixture-id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
  const calls=[], selections=[], admitted=[], inserts=[];
  Database.prototype.prepare=function(sql,...args){
    const statement=prepare.call(this,sql,...args);
    if(!/^\s*INSERT\s+INTO\s+(?:main\.)?siwc_account_attempts\b/i.test(sql)) return statement;
    return new Proxy(statement,{get(target,key){
      if(key==='run') return (...values)=>{const result=target.run(...values);inserts.push(values[0]);return result;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  };
  let observedGuard=false, activeWriter;
  provider=http.createServer((req,res)=>{ calls.push(req.headers.authorization); req.resume(); res.writeHead(200,{'content-type':'text/event-stream'}); res.end(responseStream); });
  await bounded(listenFixture(provider),'provider listen');
  globalThis.fetch=(url,opts)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');return nativeFetch(`http://127.0.0.1:${provider.address().port}/`,opts);};
  accountPool.selectCandidate=async function(...args){
    const candidate=await select.apply(this,args); selections.push(candidate?.id);
    if(selections.length===1){
      assert.equal(candidate?.id,'a');
      // A competing in-process failure is recorded after selection, without
      // fabricating a durable 429. This exercises the local-only admission guard.
      assert.equal(db.prepare("SELECT count(*) n FROM account_429_cooldowns WHERE kind='siwc' AND account_id='a'").get().n,0);
      accountPool.recordSiwcFailure('a',store.readSnapshot('a').revision);
      assert.equal(cooling.call(accountPool,'a',store.readSnapshot('a').revision),true);
    }
    return candidate;
  };
  accountPool.siwcCooling=function(id,revision){
    const result=cooling.call(this,id,revision);
    if(id==='a' && result && activeWriter?.inTransaction){
      assert.equal(activeWriter.prepare("SELECT count(*) n FROM account_429_cooldowns WHERE kind='siwc' AND account_id='a'").get().n,0);
      observedGuard=true;
    }
    return result;
  };
  Database.prototype.exec=function(sql){
    if(sql==='COMMIT' && this.inTransaction){
      const rows=this.prepare('SELECT account_id FROM siwc_account_attempts').all();
      for(const row of rows) admitted.push(row.account_id);
    }
    const result=exec.call(this,sql);
    if(sql==='BEGIN IMMEDIATE') activeWriter=this;
    if((sql==='COMMIT' || sql==='ROLLBACK') && activeWriter===this) activeWriter=undefined;
    return result;
  };
  let ready,fail; const startup=new Promise((resolve,reject)=>{ready=resolve;fail=reject;});
  express.application.listen=function(_port,_host,callback){server=http.createServer(this);listenFixture(server).then(()=>{callback();ready();}).catch(fail);return server;};
  try {await import('../src/server.ts');} finally {express.application.listen=originalListen;}
  assert.ok(server); await bounded(startup,'server startup');
  assert.equal(server.listening,true); assert.notEqual(server.address().port,20128);
  const request=(key)=>bounded(new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));res.on('error',reject);});
    requests.add(req); req.on('close',()=>requests.delete(req)); req.on('error',reject); req.setTimeout(6000,()=>req.destroy(new Error('request timeout'))); req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{strategy:'priority'}}));
  }),'request');
  const before=users.getTodayUsageCount(user.id);
  assert.equal((await request('wrong-key')).status,401);
  assert.equal(users.getTodayUsageCount(user.id),before);
  const result=await request('fixture-key');
  assert.equal(result.status,200,result.text);
  assert.deepEqual(selections,['a','b']); assert.deepEqual(calls,['Bearer token-b']);
  assert.equal(observedGuard,true,'local cooldown was not checked in admission transaction');
  assert.equal(admitted.includes('a'),false,'A was admitted'); assert.ok(admitted.includes('b'),'B admission not observed');
  assert.deepEqual(inserts,['b'],'unexpected reservation insertion, including rolled-back attempts');
  const deadline=Date.now()+8000;
  while(db.prepare("SELECT count(*) n FROM siwc_usage_logs WHERE account_id='b'").get().n!==1){
    if(Date.now()>deadline) throw new Error('usage persistence timed out');
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(users.getTodayUsageCount(user.id),before+1);
  assert.equal(db.prepare("SELECT count(*) n FROM account_429_cooldowns WHERE kind='siwc' AND account_id='a'").get().n,0);
  process.send?.({event:'passed'});
} catch(e) {primaryFailed=true;primary=e;} finally {
  // Request/socket closure does not prove asynchronous handlers have finished.
  // Leave the DB open for OS process teardown; the parent waits for child close
  // before removing the fixture, and retains it if that barrier is unconfirmed.
  const result=await cleanupFixture({primaryFailed,primary,safeToCloseDb:false,
    closeServer:async()=>{
      const errors=[];
      for(const req of requests) try {req.destroy();} catch(e) {errors.push(e);}
      try {await closeFixtureServer(server);} catch(e) {errors.push(e);}
      if(errors.length) throw new AggregateError(errors,'request or server cleanup failed');
    },
    closeProvider:()=>closeFixtureServer(provider), closeDb:closeDatabase,
  });
  express.application.listen=originalListen; accountPool.selectCandidate=select; accountPool.siwcCooling=cooling; Database.prototype.exec=exec; Database.prototype.prepare=prepare; globalThis.fetch=nativeFetch;
  if(result.errors.length) throw new AggregateError(result.errors,'SIWC worker failed or cleanup failed');
}
