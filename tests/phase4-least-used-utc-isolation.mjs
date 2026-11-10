import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('./phase4-least-used-utc-http-worker.mjs',import.meta.url));
const hangWorker=fileURLToPath(new URL('./phase4-least-used-utc-hang-worker.mjs',import.meta.url));
const loader=import.meta.resolve('tsx');

export async function runIsolated(mode, timeout, {spawnChild=spawn,closeGraceMs=5000,startupTimeoutMs=15000}={}) {
 if(!['suite','hang','poison'].includes(mode)) throw new Error('Unknown worker mode');
 const dir=mkdtempSync(path.join(process.env.TMPDIR || tmpdir(),'utc-isolated-'));
 const started=Date.now(); let closed=false, preserve=false, timedOut=false, startupTimedOut=false, ready=false, overflow=false, output='', count=0, child, signalResult='not attempted';
 try {
  const env={NODE_ENV:'test',TMPDIR:dir,TMP:dir,TEMP:dir,HOME:dir,USERPROFILE:dir,TZ:'UTC',SystemRoot:process.env.SystemRoot || 'C:\\Windows',WINDIR:process.env.WINDIR || 'C:\\Windows'};
  if(mode==='poison') env.FIXTURE_UNCOOPERATIVE='1';
  child=spawnChild(process.execPath,['--import',loader,mode==='hang'?hangWorker:worker],{cwd:dir,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const stop=()=>{
   if(child.exitCode!==null || child.signalCode!==null) {signalResult='already exited; close pending';return;}
   try {signalResult=child.kill('SIGKILL')?'signal accepted':'signal rejected';}
   catch {signalResult='signal threw';}
  };
  let timer, closeTimer, spawnError, resolveDone, rejectDone;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const noop=()=>{};
  const detach=()=>{
   child.stdout.off('data',collect);child.stderr.off('data',collect);
   child.off('error',onError);child.off('close',onClose);
  };
  const onError=err=>{spawnError=err;};
  const onClose=(code,signal)=>{closed=true;clearTimeout(timer);clearTimeout(closeTimer);detach();resolveDone({code,signal});};
  let guarded=false;
  const deadline=()=>{
   if(guarded) return;
   guarded=true;preserve=true;
   let detachFailed=false;
   const streams=[...new Set([child.stdout,child.stderr].filter(Boolean))];
   const guardedEmitters=[...new Set([child,...streams])];
   // These are our guards, independent of foreign listeners and their lifetimes.
   for(const emitter of guardedEmitters) emitter.on('error',noop);
   child.once('close',()=>{for(const emitter of guardedEmitters) emitter.off('error',noop);});
   detach();
   for(const stream of streams) {
    try {stream.destroy();} catch {detachFailed=true;}
   }
   try {child.unref();} catch {detachFailed=true;}
   rejectDone(new Error(`Worker close not confirmed (test-owned PID ${child.pid ?? 'unknown'}; SIGKILL ${signalResult}); OS may prevent termination. Preserved directory: ${dir}${detachFailed?'; handle detachment failed':''}`));
  };
  const terminate=()=>{stop();if(!closeTimer) closeTimer=setTimeout(deadline,closeGraceMs);};
  const expire=()=>{timedOut=true;startupTimedOut=mode==='hang'&&!ready;terminate();};
  const collect=chunk=>{
   count+=chunk.length;
   if(count>1024*1024){overflow=true;terminate();return;}
   output+=chunk.toString();
   if(mode==='hang'&&!ready&&output.includes('UNCOOPERATIVE_HANDLER_STARTED')) {ready=true;clearTimeout(timer);timer=setTimeout(expire,timeout);}
  };
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('error',onError);child.once('close',onClose);
  timer=setTimeout(expire,mode==='hang'?startupTimeoutMs:timeout);
  let result;
  try {
   result=await done;
  } finally {clearTimeout(timer);clearTimeout(closeTimer);}
  if(spawnError) throw spawnError;
  if(overflow) throw new Error('Worker output limit exceeded');
  if(startupTimedOut) throw new Error('Uncooperative worker did not become ready before startup timeout');
  return {...result,timedOut,ready,output,elapsed:Date.now()-started,closedBeforeCleanup:closed};
 } finally {
  if(!preserve && (closed || !child)) rmSync(dir,{recursive:true,force:true});
 }
}
