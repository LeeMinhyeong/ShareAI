import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';
import vm from 'node:vm';

if(process.argv[2]!=='--fixture-child'){
  async function run(mode){
    const cwd=process.env.TMPDIR;assert.ok(cwd && isAbsolute(cwd),'absolute TMPDIR required');
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--fixture-child',mode],{cwd,env:{SystemRoot:process.env.SystemRoot??''},stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',size=0,overflow=false,timedOut=false,spawnError=false,streamError=false,closed=false,closeTimer;
    child.on('error',()=>{spawnError=true;});child.stdout.on('error',()=>{streamError=true;});child.stderr.on('error',()=>{streamError=true;});
    const collect=(which,c)=>{size+=c.length;if(size>8192){overflow=true;child.kill();return;}if(which==='out')stdout+=c.toString();else stderr+=c.toString();};
    child.stdout.on('data',c=>collect('out',c));child.stderr.on('data',c=>collect('err',c));
    let rejectClose;const completion=new Promise((resolve,reject)=>{rejectClose=reject;child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
    const timer=setTimeout(()=>{timedOut=true;child.kill();closeTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.unref();rejectClose(new Error('child close unconfirmed'));},5000);},10000);
    let result;try{result=await completion;}finally{clearTimeout(timer);clearTimeout(closeTimer);}
    assert.equal(closed,true);assert.equal(spawnError,false);assert.equal(streamError,false);assert.equal(overflow,false);assert.equal(timedOut,false);
    assert.equal(result.signal,null);assert.ok(stderr==='','unexpected child stderr');
    return {...result,stdout};
  }
  test('idle process exits naturally while active work hits retained hard deadline',{timeout:30000},async()=>{
    const idle=await run('idle');assert.equal(idle.code,0);assert.ok(idle.stdout==='LATE_WRITE_OK\n','idle completion marker missing');
    const active=await run('active');assert.equal(active.code,1);assert.ok(active.stdout==='ACTIVE_READY\nDEADLINE_FIRED\n','active deadline marker missing');
  });
}else{
  const require=createRequire(import.meta.url),ts=require('typescript'),Database=require('better-sqlite3');
  const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const db=new Database(':memory:');db.exec('CREATE TABLE fixture_writes(value TEXT)');
  let startup, initCalls=0, expiryStarts=0;
  const signals={},app={all(){},use(){},get(){},listen(_port,_host,cb){startup=cb;return {on(){},close(cb){cb();},closeAllConnections(){}};}};
  const express=Object.assign(()=>app,{json:()=>()=>{}});
  class Expiry{start(){expiryStarts++;}stopAndDrain(){return Promise.resolve();}}
  const modules={express,'./http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js':{env:{NODE_ENV:'test'}},'./utils/logger.js':{logger:{info(){},error(){}}},
    './upstream/oauth.js':{stopOAuth:()=>Promise.resolve()},'./upstream/siwc-login.js':{stopSiwc:()=>Promise.resolve(),noStoreSiwc(){}},
    './upstream/tokens.js':{drainTokenRefreshes:()=>Promise.resolve()},'./request-work.js':{requestWork:{stopAndDrain:()=>Promise.resolve()},trackedErrorHandler:handler=>handler},
    './db/client.js':{initDatabase:()=>{initCalls++;return db;},requireInitializedDatabase:()=>db,closeDatabase:()=>db.close()},
    './db/async-writer.js':{retryQuarantinedWriters(){}},'./db/account-429-v2-store.js':{assert429V2Schema(){}},
    './db/account-429-v2-expiry.js':{Account429V2Expiry:Expiry},'./routes/v1.js':{},'./routes/admin.js':{}};
  let signalAt;
  const shim={on(name,handler){signals[name]=handler;},exit(code){
    const elapsed=process.hrtime.bigint()-signalAt;
    if(process.argv[3]!=='active'||code!==1||elapsed<4800000000n||elapsed>8000000000n)process.exit(6);
    process.stdout.write('DEADLINE_FIRED\n',()=>process.exit(code));
  },hrtime:process.hrtime,get exitCode(){return process.exitCode;},set exitCode(value){process.exitCode=value;}};
  const context={exports:{},process:shim,require(name){if(!Object.hasOwn(modules,name))throw Error('unexpected module');return modules[name];},setTimeout,clearTimeout};
  vm.runInNewContext(compiled,context,{timeout:1000});
  if(typeof startup!=='function')process.exit(7);startup();
  if(initCalls!==1||expiryStarts!==1)process.exit(8);
  signalAt=process.hrtime.bigint();signals.SIGTERM();
  if(process.argv[3]==='active'){
    setInterval(()=>{},1000);
    setTimeout(()=>{if(!db.open)process.exit(4);process.stdout.write('ACTIVE_READY\n');},50);
  }else{
    setTimeout(()=>{if(!db.open)process.exit(4);db.prepare('INSERT INTO fixture_writes VALUES (?)').run('late');if(db.prepare('SELECT count(*) n FROM fixture_writes').get().n!==1)process.exit(5);process.stdout.write('LATE_WRITE_OK\n');},50);
  }
}
