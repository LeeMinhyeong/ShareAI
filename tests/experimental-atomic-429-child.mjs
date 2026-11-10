import {fork} from 'node:child_process';

const limit=16384;
export function bounded(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(timer));
}
export function trackChild(child) {
  let closed=false, exited=false, output=0, overflow=false;
  const close=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
  child.on('error',()=>{});
  child.stderr?.on('data',chunk=>{output+=chunk.length;if(output>limit) overflow=true;});
  child.stderr?.resume();
  return {child,close,exit,get closed(){return closed;},get exited(){return exited;},get overflow(){return overflow;}};
}
export function startChild(url,args,options) { return trackChild(fork(url,args,options)); }
export async function message(handle,ms=5000) {
  const {child}=handle;
  let onMessage;
  const received=new Promise(resolve=>{onMessage=value=>resolve(value);child.once('message',onMessage);});
  try { return await bounded(Promise.race([received,handle.close.then(()=>{throw new Error('child closed before message');})]),ms,'child message'); }
  finally {child.removeListener('message',onMessage);}
}
export async function reap(handle,ms=1000) {
  if (handle.closed) return true;
  for (const signal of ['SIGTERM','SIGKILL']) {
    if (!handle.exited) { try {handle.child.kill(signal);} catch {} }
    try {await bounded(handle.close,ms,`child ${signal} close`);return true;} catch {}
  }
  handle.child.unref?.();
  for(const stream of [handle.child.stdin,handle.child.stdout,handle.child.stderr,handle.child.channel]) {stream?.destroy?.();stream?.unref?.();}
  return false;
}
