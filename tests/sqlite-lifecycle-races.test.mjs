import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire, registerHooks} from 'node:module';
import {mkdtempSync, rmSync, lstatSync, realpathSync, readdirSync} from 'node:fs';
import {join, resolve, parse, dirname, basename} from 'node:path';
import {userInfo} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function checked(path) {
  const full=resolve(path); let current=parse(full).root;
  for (const part of full.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current=join(current,part);
    if (lstatSync(current).isSymbolicLink() || !same(realpathSync(current),current)) throw Error('unsafe fixture path');
  }
  return full;
}
const root=checked(join(userInfo().homedir,'AppData','Local','hermes','cache','scratch'));
const modes=['writer-close','writer-quarantine','writer-success','init-fs','init-log','init-constructor','init-postlog','init-cleanup'];
async function run(mode) {
  assert.ok(same(checked(process.env.TMPDIR),root), 'explicit trusted TMPDIR required');
  const dir=checked(mkdtempSync(join(root,'lifecycle-race-'))); let closed=false;
  try {
    const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TMPDIR:dir,TMP:dir,TEMP:dir,
      NODE_ENV:'test',LOG_LEVEL:'error',DATABASE_URL:`sqlite:${join(dir,'fixture.sqlite')}`,
      ENCRYPTION_KEY:'0'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LIFECYCLE_CASE:mode};
    const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(import.meta.url)],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',d=>{output+=d}); child.stderr.on('data',d=>{output+=d});
    let spawnError; child.on('error',e=>{spawnError=e});
    const result=await new Promise(resolve=>{
      let done=false, killTimer;
      const timer=setTimeout(()=>{child.kill(); killTimer=setTimeout(()=>{if(!done){done=true; child.unref(); resolve({closed:false});}},5000)},15000);
      child.once('close',(code,signal)=>{if(!done){done=true;clearTimeout(timer);clearTimeout(killTimer);resolve({closed:true,code,signal})}});
    });
    closed=result.closed;
    assert.ok(closed,`child closure unconfirmed; fixture retained ${dir}, pid ${child.pid}`);
    assert.equal(spawnError,undefined); assert.equal(result.signal,null); assert.equal(result.code,0,output);
  } finally { if(closed) rmSync(dir,{recursive:true,force:true}); }
}
async function child(mode) {
  const dir=checked(process.cwd());
  assert.ok(modes.includes(mode) && same(dirname(dir),root) && /^lifecycle-race-[A-Za-z0-9]{6}$/.test(basename(dir)));
  assert.equal(process.env.TMPDIR,dir); assert.equal(process.env.TMP,dir); assert.equal(process.env.TEMP,dir);
  assert.equal(process.env.DATABASE_URL,`sqlite:${join(dir,'fixture.sqlite')}`);
  assert.equal(process.env.NODE_ENV,'test'); assert.deepEqual(readdirSync(dir),[]);
  const require=createRequire(import.meta.url), RealDatabase=require('better-sqlite3');
  let writer, originalWriterClose, shared, constructed, originalSharedClose, entered=0, callback=0, fire, constructions=0, reenter;
  globalThis.__lifecycleDb=function(path,opts){
    constructions++;
    if(mode==='init-constructor' && constructions===1) reenter();
    const db=new RealDatabase(path,opts);
    if(constructions===1) constructed=db;
    if(mode==='init-cleanup') {
      const originalClose=db.close.bind(db);
      db.pragma=()=>{throw Error('synthetic initialization failure')};
      db.close=()=>{reenter(); originalClose()};
    }
    if(mode.startsWith('writer-') && constructions===2){
      writer=db; originalWriterClose=db.close.bind(db); const exec=db.exec.bind(db);
      db.exec=sql=>{if(sql==='BEGIN IMMEDIATE' && entered++===0){const e=Error('synthetic busy'); e.code='SQLITE_BUSY'; throw e;} return exec(sql)};
    }
    return db;
  };
  const hooks=registerHooks({resolve(specifier,context,next){
    if(specifier==='better-sqlite3' && /\/db\/(client|async-writer)\.ts/.test(context.parentURL ?? '')) return {url:'data:text/javascript,export default globalThis.__lifecycleDb',shortCircuit:true};
    return next(specifier,context);
  }});
  const {getDb,initDatabase,closeDatabase}=await import('../src/db/client.ts');
  const {withAsyncWriter}=await import('../src/db/async-writer.ts');
  const {logger}=await import('../src/utils/logger.ts');
  const fs=(await import('node:fs')).default;
  const oldExists=fs.existsSync, oldLog=logger.info, oldTimer=globalThis.setTimeout;
  try {
    if(mode.startsWith('init-')) {
      let nested=0;
      reenter=()=>{nested++; assert.throws(()=>getDb(),/initializing/); assert.throws(()=>initDatabase(),/initializing/); closeDatabase();};
      if(mode==='init-fs') fs.existsSync=(...args)=>{fs.existsSync=oldExists; reenter(); return oldExists(...args)};
      if(mode==='init-log') logger.info=(...args)=>{logger.info=oldLog; reenter(); return oldLog(...args)};
      if(mode==='init-postlog') logger.info=(...args)=>{if(args[0]==='Database initialized successfully'){logger.info=oldLog; reenter();} return oldLog(...args)};
      assert.throws(()=>initDatabase(),mode==='init-cleanup' ? /synthetic initialization failure/ : /closed|closing/i);
      assert.equal(nested,1); assert.ok(constructions<=1); assert.throws(()=>getDb(),/closed/i);
      if(constructed) assert.equal(constructed.open,false);
    } else {
      shared=getDb(); originalSharedClose=shared.close.bind(shared);
      shared.exec('CREATE TABLE lifecycle_probe (n INTEGER)');
      globalThis.setTimeout=(fn,delay,...args)=>{if(delay<=20){fire=()=>fn(...args); return {}} return oldTimer(fn,delay,...args)};
      const pending=Promise.resolve(withAsyncWriter(db=>{callback++;db.exec('INSERT INTO lifecycle_probe VALUES (1)');return 42},{timeoutMs:5000}));
      assert.equal(entered,1); assert.equal(typeof fire,'function'); assert.equal(callback,0);
      if(mode==='writer-close') closeDatabase();
      if(mode==='writer-quarantine'){shared.close=()=>{throw Error('synthetic close failure')}; assert.throws(()=>closeDatabase(),/synthetic close failure/);}
      fire();
      if(mode==='writer-success'){assert.equal(await pending,42); assert.equal(callback,1); assert.equal(shared.prepare('SELECT count(*) n FROM lifecycle_probe').get().n,1);}
      else {
        await assert.rejects(pending,/initialized|closed/i); assert.equal(callback,0);
        const observer=new RealDatabase(join(dir,'fixture.sqlite'),{fileMustExist:true});
        try { assert.equal(observer.prepare('SELECT count(*) n FROM lifecycle_probe').get().n,0); }
        finally { observer.close(); assert.equal(observer.open,false); }
      }
      assert.equal(writer.open,false);
    }
  } finally {
    fs.existsSync=oldExists; logger.info=oldLog; globalThis.setTimeout=oldTimer;
    if(writer?.open) originalWriterClose();
    if(shared?.open){shared.close=originalSharedClose; closeDatabase();}
    hooks.deregister(); delete globalThis.__lifecycleDb;
  }
}
if(process.env.LIFECYCLE_CASE) await child(process.env.LIFECYCLE_CASE);
else for(const mode of modes) test(mode,()=>run(mode));
