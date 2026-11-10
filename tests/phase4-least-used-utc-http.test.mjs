import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {existsSync, rmSync} from 'node:fs';
import {runIsolated} from './phase4-least-used-utc-isolation.mjs';

const expectedCases=[
 'HTTP fixture settles timeout and assertion failures and restores instrumentation',
 'mixed priority breaks ties using UTC successes rather than stale ordinary counter',
 'mixed priority uses per-kind UTC valid successes, one as-of, then deterministic kind key',
 'UTC ranking avoids redundant local-midnight SIWC counts while round robin preserves its count',
 'UTC least-used ignores legacy counters and counts completed no-usage responses by kind',
 'UTC midnight bounds exclude failures and future events without mixing colliding IDs',
 'legacy and ISO timestamps count only completed successes through as-of, including ordinary-only result',
 'strict UTC history rejects normalized dates and sub-millisecond future values for both kinds',
 'ordinary pre-dispatch account change and provider 422 do not create cooldown',
 'aborted before ordinary invocation does not mutate account state',
 'authenticated production v1 route dispatches mixed priority winner',
 'SQLite CURRENT_TIMESTAMP default is included for the current UTC day',
];

for(const signalCase of ['rejected','threw','accepted']) test(`no close after signal ${signalCase} detaches owned handles and preserves directory`, {timeout:8000}, async()=>{
 const fake=new EventEmitter();
 fake.pid=424242; fake.exitCode=null; fake.signalCode=null;
 fake.stdout=new PassThrough(); fake.stderr=new PassThrough(); fake.stdio=[null,fake.stdout,fake.stderr];
 const foreign=()=>{}, foreignPersistent=()=>{};
 fake.on('close',foreign); fake.once('error',foreign);
 fake.stdout.once('error',foreign); fake.stderr.once('error',foreign);
 for(const emitter of [fake,fake.stdout,fake.stderr]) emitter.on('error',foreignPersistent);
 fake.stdout.on('data',foreign); fake.stderr.on('data',foreign);
 fake.kill=()=>{if(signalCase==='threw') throw new Error('synthetic secret'); return signalCase==='accepted';}; let unref=false, dir;
 const handle=setInterval(()=>{},1000);
 fake.unref=()=>{unref=true;handle.unref();};
 const started=Date.now();
 const originalSetTimeout=globalThis.setTimeout, timers=[];
 globalThis.setTimeout=(...args)=>{const timer=originalSetTimeout(...args);timers.push(timer);return timer;};
 try {
  await assert.rejects(runIsolated('hang',30,{startupTimeoutMs:30,closeGraceMs:40,spawnChild:(_exe,_args,options)=>{dir=options.cwd;return fake;}}),error=>{
   assert.match(error.message,/424242/);
   assert.ok(error.message.includes(dir));
   assert.match(error.message,/not confirmed/i);
   assert.ok(error.message.includes(`signal ${signalCase}`));
   assert.ok(!error.message.includes('synthetic secret'));
   assert.match(error.message,/OS may prevent termination/);
   return true;
  });
  assert.ok(Date.now()-started<2000);
  assert.equal(unref,true);
  assert.equal(handle.hasRef(),false);
  assert.equal(timers.length,2);
  assert.ok(timers.every(timer=>timer._destroyed),'deadline timers must be cleared');
  assert.equal(fake.stdout.destroyed,true); assert.equal(fake.stderr.destroyed,true);
  assert.ok(fake.listeners('close').includes(foreign));
  assert.deepEqual(fake.stdout.listeners('data'),[foreign]); assert.deepEqual(fake.stderr.listeners('data'),[foreign]);
  for(const emitter of [fake,fake.stdout,fake.stderr]) {
   assert.ok(emitter.listeners('error').includes(foreign));
   assert.doesNotThrow(()=>emitter.emit('error',new Error('consume foreign once')));
   assert.ok(emitter.listeners('error').includes(foreignPersistent));
   emitter.off('error',foreign);emitter.off('error',foreignPersistent);
   for(let i=0;i<2;i++) assert.doesNotThrow(()=>emitter.emit('error',new Error('late error')));
   assert.equal(emitter.listenerCount('error'),1);
  }
  assert.equal(existsSync(dir),true);
  fake.emit('close',null,'SIGKILL');
  for(const emitter of [fake,fake.stdout,fake.stderr]) assert.equal(emitter.listenerCount('error'),0);
  assert.deepEqual(fake.listeners('close'),[foreign]);
 } finally {globalThis.setTimeout=originalSetTimeout;clearInterval(handle); assert.equal(handle._destroyed,true); if(dir) rmSync(dir,{recursive:true,force:true});}
});

test('startup timeout kills and reaps a child that never becomes ready', {timeout:5000}, async()=>{
 const fake=new EventEmitter(); let dir, killed=false;
 fake.pid=424243; fake.exitCode=null; fake.signalCode=null;
 fake.stdout=new PassThrough(); fake.stderr=new PassThrough(); fake.stdio=[null,fake.stdout,fake.stderr];
 fake.kill=()=>{killed=true;setImmediate(()=>fake.emit('close',null,'SIGKILL'));return true;};
 try {
  await assert.rejects(runIsolated('hang',30,{startupTimeoutMs:50,closeGraceMs:500,spawnChild:(_exe,_args,options)=>{dir=options.cwd;return fake;}}),/did not become ready/);
  assert.equal(killed,true); assert.equal(existsSync(dir),false);
  assert.equal(fake.listenerCount('close'),0); assert.equal(fake.listenerCount('error'),0);
  assert.equal(fake.stdout.listenerCount('data'),0); assert.equal(fake.stderr.listenerCount('data'),0);
 } finally {fake.stdout.destroy();fake.stderr.destroy();if(dir) rmSync(dir,{recursive:true,force:true});}
});

test('post-ready timeout starts only after handler readiness', {timeout:5000}, async()=>{
 const fake=new EventEmitter(); let ready=false, killedBeforeReady=false, dir;
 fake.pid=424244; fake.exitCode=null; fake.signalCode=null;
 fake.stdout=new PassThrough(); fake.stderr=new PassThrough(); fake.stdio=[null,fake.stdout,fake.stderr];
 fake.kill=()=>{killedBeforeReady=!ready;setImmediate(()=>fake.emit('close',null,'SIGKILL'));return true;};
 const readyTimer=setTimeout(()=>{ready=true;fake.stdout.write('UNCOOPERATIVE_HANDLER_STARTED\n');},120);
 try {
  const result=await runIsolated('hang',30,{startupTimeoutMs:1000,closeGraceMs:500,spawnChild:(_exe,_args,options)=>{dir=options.cwd;return fake;}});
  assert.equal(result.ready,true); assert.equal(result.timedOut,true); assert.equal(result.closedBeforeCleanup,true);
  assert.equal(killedBeforeReady,false); assert.equal(existsSync(dir),false);
 } finally {clearTimeout(readyTimer);fake.stdout.destroy();fake.stderr.destroy();if(dir) rmSync(dir,{recursive:true,force:true});}
});

test('actual hung child is killed and closed before cleanup', {timeout:30000}, async()=>{
 const hung=await runIsolated('hang',1500);
 assert.equal(hung.timedOut,true);
 assert.equal(hung.ready,true);
 assert.match(hung.output,/UNCOOPERATIVE_HANDLER_STARTED/);
 assert.equal(hung.closedBeforeCleanup,true);
 assert.ok(hung.elapsed<25000);
});

test('uncooperative child is reaped before cleanup and a fresh suite succeeds', {timeout:110000}, async()=>{
 const hung=await runIsolated('hang', 1500);
 assert.equal(hung.timedOut,true);
 assert.equal(hung.ready,true);
 assert.match(hung.output,/UNCOOPERATIVE_HANDLER_STARTED/);
 assert.equal(hung.closedBeforeCleanup,true);
 assert.ok(hung.elapsed<30000);
 const poisoned=await runIsolated('poison',15000);
 assert.equal(poisoned.timedOut,false);
 assert.equal(poisoned.code,1);
 assert.match(poisoned.output,/Unsettled HTTP fixture; terminating isolated worker/);
 assert.equal(poisoned.closedBeforeCleanup,true);
 const success=await runIsolated('suite', 40000);
 assert.equal(success.timedOut,false);
 assert.equal(success.code,0,success.output);
 assert.match(success.output,/(?:#|ℹ) tests 12\b/);
 assert.match(success.output,/(?:#|ℹ) pass 12\b/);
 assert.match(success.output,/(?:#|ℹ) skipped 0\b/);
 for(const name of expectedCases) assert.ok(success.output.includes(name),`Missing test: ${name}`);
 assert.equal(success.closedBeforeCleanup,true);
});
