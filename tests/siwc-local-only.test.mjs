import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,lstatSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('./siwc-local-only-worker.mjs',import.meta.url));
const bounded=(p,ms,label)=>{let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(t));};
// Portability limitation: callers must configure a trusted absolute scratch
// directory in TMPDIR, including on Windows; no OS temp fallback is used.
// This check cannot defeat ancestor links or replacement races.
const scratchRoot=(root=process.env.TMPDIR)=>{
  try {if(root && path.isAbsolute(root) && lstatSync(root).isDirectory()) return path.resolve(root);} catch {}
  throw new Error('SIWC local-only tests require TMPDIR to name an existing trusted absolute scratch directory');
};

test('scratch root requires an explicit absolute directory',()=>{
  for(const root of ['', 'relative-scratch', path.join(scratchRoot(),'missing-siwc-scratch')])
    assert.throws(()=>scratchRoot(root),/require TMPDIR.*trusted absolute scratch directory/);
});

test('cleanup preserves falsy primary and independent cleanup failures',async()=>{
  const {cleanupFixture}=await import('./siwc-local-only-cleanup.mjs');
  const attempted=[];
  const result=await cleanupFixture({
    primaryFailed:true, primary:undefined, timeout:50, safeToCloseDb:true,
    closeServer:()=>{attempted.push('server');throw false;},
    closeProvider:()=>{attempted.push('provider');throw null;},
    closeDb:()=>{attempted.push('db');throw 0;},
  });
  assert.deepEqual(attempted.sort(),['db','provider','server']);
  assert.deepEqual(result.errors,[undefined,false,null,0]);
});

test('cleanup bounds hung closes and skips unsafe database closure',async()=>{
  const {cleanupFixture}=await import('./siwc-local-only-cleanup.mjs');
  const attempted=[];
  const result=await cleanupFixture({primaryFailed:false, timeout:20, safeToCloseDb:false,
    closeServer:()=>{attempted.push('server');return new Promise(()=>{});},
    closeProvider:()=>{attempted.push('provider');}, closeDb:()=>{attempted.push('db');},
  });
  assert.deepEqual(attempted,['server','provider']);
  assert.match(result.errors[0].message,/server close timed out/);
});

test('server close is attempted if connection destruction fails',async()=>{
  const {closeFixtureServer}=await import('./siwc-local-only-cleanup.mjs');
  const failure=new Error('destroy failed'); let closed=false;
  await assert.rejects(closeFixtureServer({listening:true,closeAllConnections(){throw failure;},close(cb){closed=true;cb();}}),
    error=>error instanceof AggregateError && error.errors[0]===failure);
  assert.equal(closed,true);
});

test('listener candidates exclude reserved port and retry only address-in-use',async()=>{
  const {listenFixture}=await import('./siwc-local-only-listen.mjs');
  const attempts=[];
  class Fake extends EventEmitter {
    listen(port,host){attempts.push([port,host]);queueMicrotask(()=>attempts.length===1?this.emit('error',Object.assign(new Error('busy'),{code:'EADDRINUSE'})):this.emit('listening'));return this;}
  }
  let i=0;
  await listenFixture(new Fake(),()=>[20128,32101,32102][i++]);
  assert.deepEqual(attempts,[[32101,'127.0.0.1'],[32102,'127.0.0.1']]);
  const error=Object.assign(new Error('denied'),{code:'EACCES'});
  class Denied extends EventEmitter {listen(){queueMicrotask(()=>this.emit('error',error));}}
  await assert.rejects(listenFixture(new Denied(),()=>32103),e=>e===error);
});

async function runInvalidWorker(ownedName,write=writeFileSync){
  const root=scratchRoot();
  let dir,child,closed=false,closePromise,primaryFailed=false,primary;
  try {
    dir=mkdtempSync(path.join(root,ownedName?'siwc-local-only-':'siwc-sentinel-'));
    const file=path.join(dir,ownedName?'fixture.sqlite':'sentinel.sqlite');
    const token=randomBytes(32).toString('hex');
    write(path.join(dir,'.siwc-fixture-owner'),token,{flag:'wx'});
    write(file,'synthetic sentinel');
    const env=Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP','TMPDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    env.SIWC_FIXTURE_ROOT=root;
    env.SIWC_FIXTURE_OWNER=token;
    child=fork(worker,[file],{cwd:dir,env,execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
    let output='';
    child.on('error',()=>{}); child.stdout.on('error',()=>{}); child.stderr.on('error',()=>{});
    for(const stream of [child.stdout,child.stderr]) stream.on('data',c=>{output+=c;if(output.length>100000) child.kill();});
    closePromise=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
    const result=await bounded(closePromise,10000,'invalid worker close');
    assert.notEqual(result.code,0);
    assert.equal(output.trim(),'SIWC fixture validation failed');
    assert.equal(readFileSync(file,'utf8'),'synthetic sentinel');
  } catch(e) {primaryFailed=true;primary=e;} finally {
    const errors=primaryFailed?[primary]:[];
    if(child&&!closed){try {child.kill();} catch(e) {errors.push(e);} try{await bounded(closePromise,5000,'invalid worker termination');}catch(e){errors.push(e);}}
    try {
      if(dir) {
        if(!child||closed) rmSync(dir,{recursive:true,force:true});
        else throw new Error(`worker close unconfirmed (pid ${child.pid}); retained fixture ${dir}`);
      }
    } catch(e) {errors.push(e);}
    if(errors.length) throw new AggregateError(errors,'invalid worker test or cleanup failed');
  }
}

for(const failAt of [1,2]) test(`direct worker setup write ${failAt} failure cleans its directory and preserves the error`,async()=>{
  const failure=new Error('injected setup write failure');
  let dir,writes=0;
  try {
    let caught;
    try {await runInvalidWorker(false,(file,...args)=>{dir=path.dirname(file);if(++writes===failAt) throw failure;writeFileSync(file,...args);});} catch(e) {caught=e;}
    assert.ok(dir);
    assert.equal(writes,failAt);
    assert.throws(()=>lstatSync(dir),{code:'ENOENT'});
    assert.ok(caught instanceof AggregateError && caught.errors.includes(failure));
  } finally {
    if(dir) rmSync(dir,{recursive:true,force:true});
  }
});

for(const ownedName of [false,true]) test(`direct worker rejects ${ownedName?'existing owned-name':'unowned'} database before opening it`,{timeout:15000},()=>runInvalidWorker(ownedName));

test('local-only cooldown prevents admission and reselects over the production route',{timeout:30000},async()=>{
  const root=scratchRoot();
  const dir=mkdtempSync(path.join(root,'siwc-local-only-'));
  let child, closed=false, closePromise, passed=false, output='', overflow=false,primaryFailed=false,primary;
  try {
    const env=Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path','TEMP','TMP','TMPDIR'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    const token=randomBytes(32).toString('hex');
    writeFileSync(path.join(dir,'.siwc-fixture-owner'),token,{flag:'wx'});
    env.SIWC_FIXTURE_OWNER=token;
    env.SIWC_FIXTURE_ROOT=root;
    child=fork(worker,[path.join(dir,'fixture.sqlite')],{cwd:dir,env,execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
    child.on('error',()=>{}); child.stdout.on('error',()=>{}); child.stderr.on('error',()=>{});
    closePromise=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
    child.on('message',m=>{if(m?.event==='passed') passed=true;});
    for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{output+=chunk.toString();if(output.length>100000){overflow=true;child.kill();}});
    const result=await bounded(closePromise,20000,'worker close');
    assert.equal(overflow,false,'worker output exceeded limit');
    assert.equal(result.code,0,`worker failed (signal ${result.signal}); diagnostics withheld`);
    assert.equal(passed,true,'worker did not report assertions completed');
    assert.equal(['fixture-key','token-a','token-b','fixture-id','a'.repeat(64),'x'.repeat(20)].some(s=>output.includes(s)),false,'worker output leaked fixture secret');
  } catch(e) {primaryFailed=true;primary=e;} finally {
    const errors=primaryFailed?[primary]:[];
    if(child && !closed){try {child.kill();} catch(e) {errors.push(e);} try{await bounded(closePromise,5000,'killed worker close');}catch(e){errors.push(e);}}
    try {
      if(!child || closed) rmSync(dir,{recursive:true,force:true});
      else throw new Error(`worker close unconfirmed (pid ${child.pid}); retained fixture ${dir}`);
    } catch(e) {errors.push(e);}
    if(errors.length) throw new AggregateError(errors,'worker test or cleanup failed');
  }
});
