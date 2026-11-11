import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const ts=require('typescript');
const Database=require('better-sqlite3');
const source=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;

test('shutdown retains DB for work outside currently tracked drains',async()=>{
  const db=new Database(':memory:');db.exec('CREATE TABLE fixture_writes(value TEXT)');
  const events=[],signals={},timers=[]; let startup;
  const server={on(){},close(callback){events.push('http-close');callback();events.push('http-callback-returned');},closeAllConnections(){events.push('connections');}};
  const app={all(){},use(){},get(){},listen(_port,_host,cb){startup=cb;return server;}};
  const express=Object.assign(()=>app,{json:()=>()=>{}});
  const drain=name=>Promise.resolve().then(()=>{events.push(`${name}-drained`);});
  class Expiry {start(){events.push('expiry-start');} stopAndDrain(){return drain('expiry');}}
  const modules={
    express,
    './http/raw-body.js':{captureRawBody(){},JSON_BODY_LIMIT:'10mb'},'./config/env.js':{env:{PORT:1,HOST:'fixture',NODE_ENV:'test'}},
    './utils/logger.js':{logger:{info(){},error(){}}},
    './upstream/oauth.js':{stopOAuth:()=>drain('oauth')},
    './upstream/siwc-login.js':{stopSiwc:()=>drain('siwc'),noStoreSiwc(){}},
    './upstream/tokens.js':{drainTokenRefreshes:()=>drain('tokens')},
    './request-work.js':{requestWork:{stopAndDrain:()=>drain('requests')},trackedErrorHandler:handler=>handler},
    './db/client.js':{initDatabase:()=>{events.push('db-init');return db;},requireInitializedDatabase:()=>db,closeDatabase(){events.push('db-close');db.close();}},
    './db/async-writer.js':{retryQuarantinedWriters(){events.push('writer-close');}},
    './db/account-429-v2-store.js':{assert429V2Schema(){}},
    './db/account-429-v2-expiry.js':{Account429V2Expiry:Expiry},
    './routes/v1.js':{},'./routes/admin.js':{},
  };
  const proc={on(name,fn){signals[name]=fn;},exit(code){events.push(`exit:${code}`);},hrtime:{bigint:()=>0n}};
  const context={exports:{},process:proc,require(name){assert.ok(Object.hasOwn(modules,name),'unexpected module');return modules[name];},
    setTimeout(callback,delay){const timer={callback,delay,cleared:false,unrefCalled:false,unref(){this.unrefCalled=true;return this;}};timers.push(timer);return timer;},
    clearTimeout(timer){timer.cleared=true;}};
  try{
    vm.runInNewContext(compiled,context,{timeout:1000});
    assert.equal(typeof startup,'function');startup();
    assert.ok(events.includes('db-init') && events.includes('expiry-start'));
    assert.equal(typeof signals.SIGTERM,'function');
    signals.SIGTERM();
    await new Promise(resolve=>setImmediate(resolve));
    for(const event of ['http-close','http-callback-returned','requests-drained','oauth-drained','siwc-drained','tokens-drained','expiry-drained'])assert.ok(events.includes(event),`missing ${event}`);
    // Model a DB-capable continuation not registered with the current drains.
    assert.equal(db.open,true,'untracked work can still need the DB after drains complete');
    db.prepare('INSERT INTO fixture_writes VALUES (?)').run('late');
    assert.equal(db.prepare('SELECT count(*) n FROM fixture_writes').get().n,1);
    assert.equal(events.includes('db-close'),false);
    assert.equal(events.includes('writer-close'),false);
    assert.equal(timers.length,1);assert.equal(timers[0].delay,5000);
    assert.equal(timers[0].cleared,false,'hard deadline must remain armed');
    assert.equal(timers[0].unrefCalled,true,'successful shutdown must not keep an otherwise idle process alive');
  }finally{if(db.open)db.close();}
});
