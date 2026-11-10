import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,realpathSync,openSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {createFixture} from './experimental-atomic-429-fixture.mjs';
import {bounded,message,reap,startChild,trackChild} from './experimental-atomic-429-child.mjs';
const scratch=realpathSync(join(homedir(),'AppData','Local','hermes','cache','scratch'));
assert.equal(realpathSync(tmpdir()),scratch,'TMPDIR must explicitly point to Hermes scratch');

test('independent writers race the same OPEN and exactly one settles', {timeout:30000},async()=>{
  const dir=mkdtempSync(join(scratch,'atomic-429-'));
  const file=join(dir,'fixture.db');
  const children=[]; let db;
  const env={SystemRoot:process.env.SystemRoot,TMPDIR:dir,TEMP:dir,TMP:dir};
  try {
    closeSync(openSync(file,'wx',0o600));
    db=new Database(file,{fileMustExist:true}); createFixture(db);
    db.prepare('INSERT INTO main.ordinary_account_attempts VALUES (?,?)').run('race','owner');
    for(let i=0;i<2;i++) {
      const h=startChild(new URL('./experimental-atomic-429-settle-worker.mjs',import.meta.url),[resolve(file)],{cwd:dir,env,execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','pipe','ipc']});
      children.push(h); assert.equal(await message(h),'ready');
    }
    const replies=children.map(h=>message(h));
    children.forEach(h=>h.child.send('go'));
    const results=await Promise.all(replies);
    const exits=await Promise.all(children.map(h=>bounded(h.exit,6000,'child exit')));
    const closes=await Promise.all(children.map(h=>bounded(h.close,2000,'child stdio close')));
    for(const [i,h] of children.entries()) {assert.equal(exits[i].code,0);assert.equal(closes[i].code,0);assert.equal(h.overflow,false);}
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.match(results.find(r=>!r.ok).error,/ownership lost/);
    assert.equal(db.prepare('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?').get('race'),undefined);
    assert.deepEqual(db.prepare('SELECT generation,duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get('upstream','race'),{generation:1n,duration_ns:50n});
  } finally {
    const reaped=await Promise.all(children.map(h=>reap(h)));
    db?.close();
    if(reaped.every(Boolean)) rmSync(dir,{recursive:true,force:true});
    else throw new Error(`Child closure unconfirmed; preserved ${dir}; pids ${children.filter((_,i)=>!reaped[i]).map(h=>h.child.pid).join(',')}`);
  }
});

test('no-close child is bounded, signalled and detached',async()=>{
  const fake=new EventEmitter(); const signals=[]; let detached=false;
  fake.kill=signal=>signals.push(signal);fake.unref=()=>{detached=true;};
  const h=trackChild(fake);
  assert.equal(await reap(h,20),false);
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(detached,true);
});

test('owned uncooperative child is reaped',async()=>{
  const dir=mkdtempSync(join(scratch,'atomic-429-hang-'));
  let h;
  try {
    h=startChild(new URL('./experimental-atomic-429-hang-worker.mjs',import.meta.url),[],{
      cwd:dir,env:{SystemRoot:process.env.SystemRoot,TMPDIR:dir,TEMP:dir,TMP:dir},
      execArgv:[],stdio:['ignore','ignore','pipe','ipc']
    });
    const ready=await message(h);
    assert.equal(ready.ready,true);
    assert.equal(realpathSync(ready.cwd),realpathSync(dir));
  } finally {
    const closed=!h || await reap(h,500);
    if(closed) rmSync(dir,{recursive:true,force:true});
    else throw new Error(`Child closure unconfirmed; preserved ${dir}; pid ${h.child.pid}`);
  }
});
