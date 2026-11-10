import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {streamDiagnostic} from './siwc-fixture-diagnostics.mjs';

const worker=fileURLToPath(new URL('./siwc-local-cooldown-reselect-worker.mjs',import.meta.url));
const loader=import.meta.resolve('tsx');

async function runFixture(hang=false,startupCode){
 const root=path.resolve(process.env.TMPDIR || os.tmpdir());
 const dir=mkdtempSync(path.join(root,'siwc-local-race-'));
 let child,closed=false,primary,failed=false, result, caught, hasCaught=false, fixtureError=false;
 let token;
 const streams={stdout:{chunks:[],size:0,truncated:false},stderr:{chunks:[],size:0,truncated:false}};
 const render=streamDiagnostic;
 try {
  token=randomBytes(32).toString('hex');
  writeFileSync(path.join(dir,'.siwc-fixture-owner'),token,{flag:'wx'});
  const env={PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, TEMP:dir,TMP:dir,TMPDIR:dir,HOME:dir,USERPROFILE:dir,SIWC_FIXTURE_ROOT:root,SIWC_FIXTURE_OWNER:token,SIWC_FIXTURE_HANG:hang?'1':'0'};
  const args=startupCode===undefined?['--import',loader,worker,path.join(dir,'fixture.sqlite')]:['-e',startupCode];
  child=spawn(process.execPath,args,{cwd:dir,env,stdio:['ignore','pipe','pipe','ipc']});
  let bytes=0, active=false, deadline, forceTimer;
  const errors=[];
  // Keep guards installed even if close is unconfirmed; errors after close
  // must still fail the test process instead of becoming silent success.
  const onError=e=>{if(closed) throw new Error('fixture process/stream error after close');errors.push(e);};
  child.on('error',onError);
  for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]]){
   const output=streams[name];
   stream.on('error',onError);
   stream.on('data',chunk=>{
    const take=Math.min(chunk.length,65536-output.size);
    if(take){output.chunks.push(Buffer.from(chunk.subarray(0,take)));output.size+=take;}
    if(take<chunk.length)output.truncated=true;
    bytes+=chunk.length;
    if(bytes>65536&&!failed){failed=true;primary=new Error('fixture output exceeded 65536 bytes');child.kill();}
   });
  }
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
  const expire=label=>{if(!failed){failed=true;primary=new Error(label);}child.kill();};
  deadline=setTimeout(()=>expire('fixture deadline exceeded'),30000);
  child.on('message',message=>{if(message?.type==='fixture-error')fixtureError=true;if(message==='handler-active'&&hang&&!active){active=true;clearTimeout(deadline);deadline=setTimeout(()=>expire('active handler deadline exceeded'),300);}});
  result=await Promise.race([done,new Promise(resolve=>{forceTimer=setTimeout(()=>resolve(null),35000);})]);
  clearTimeout(deadline);clearTimeout(forceTimer);
  if(!result){child.kill();child.unref();child.stdout.destroy();child.stderr.destroy();if(child.connected)child.disconnect();throw new Error(`fixture close unconfirmed; preserved ${dir}, pid ${child.pid}`);}
  if(errors.length) throw new AggregateError(errors,'fixture process/stream error');
  if(hang){assert.equal(active,true,'hung handler was never reached');assert.equal(failed,true,'active handler deadline did not fire');assert.equal(primary?.message,'active handler deadline exceeded');assert.notEqual(result.code,0);}
  else {if(failed)throw primary;if(result.code!==0)throw new Error('fixture failed');}
 } catch(e){hasCaught=true;caught=failed && e!==primary ? new AggregateError([primary,e],'fixture and process failure') : e;}
 finally {
  if(!child||closed){try {rmSync(dir,{recursive:true,force:true});} catch(e){caught=hasCaught?new AggregateError([caught,e],'fixture and removal failed'):e;hasCaught=true;}}
 }
 if(hasCaught){
  const category=!closed&&child?`fixture close unconfirmed; fixture preserved as ${path.basename(dir)}; pid ${child.pid}`:failed && primary?.message==='fixture output exceeded 65536 bytes'?'fixture output exceeded 65536 bytes':failed?'fixture deadline or process failure':result&&result.code!==0?`fixture failed (code ${result.code}, signal ${result.signal})`:'fixture setup, process, or cleanup failure';
  throw new Error(`${category}${fixtureError?'\nfixture worker failed; inspect the synthetic fixture and its startup dependencies':''}\nstdout:\n${render(streams.stdout)}\nstderr:\n${render(streams.stderr)}`);
 }
 return result;
}

test('startup failure reports bounded, secret-safe stdout and stderr',async()=>{
 const code="process.stdout.write('startup stdout fixture-key '+process.env.SIWC_FIXTURE_OWNER+'\\n');process.stderr.write('startup import failure token-a\\n');process.exit(23)";
 let message='';
 try {await runFixture(false,code);} catch(e){message=String(e.stack ?? e);}
 assert.ok(message.includes('fixture failed (code 23, signal null)\nstdout:\nchild output omitted\nstderr:\nstartup import failure'), 'missing categorized startup diagnostic');
 assert.ok(!message.includes('fixture-key')&&!message.includes('token-a')&&!/[a-f0-9]{64}/.test(message), 'diagnostic leaked fixture secrets');
});

test('excess child output is bounded and its cut secret tail is withheld',async()=>{
 const code="process.stdout.write('z'.repeat(65528)+'fixture-key'+'z'.repeat(70000))";
 let message='';
 try {await runFixture(false,code);} catch(e){message=String(e.stack ?? e);}
 assert.ok(message.includes('fixture output exceeded 65536 bytes'),'missing output limit failure');
 assert.ok(message.includes('[output truncated]'),'missing truncation marker');
 assert.ok(!message.includes('fixture-'),'truncated secret prefix leaked');
 assert.ok(message.length<140000,'diagnostic was not bounded');
});

test('child diagnostic never includes full or boundary-split secret fragments',async()=>{
 for(const stream of ['stdout','stderr']) {
  for(const body of [
   "'fixture-key '+process.env.SIWC_FIXTURE_OWNER+' token-g'",
   "'z'.repeat(65536-'startup import failure '.length-3)+'fixture-key'+'z'.repeat(100)",
   "'z'.repeat(65536-'startup import failure '.length-3)+process.env.SIWC_FIXTURE_OWNER+'z'.repeat(100)",
  ]) {
   const code=`process.${stream}.write('startup import failure ');process.${stream}.write(${body});process.exit(23)`;
   let message='';try {await runFixture(false,code);} catch(e){message=String(e.stack ?? e);}
   assert.ok(message.includes('startup import failure'),'missing actionable category');
   assert.ok(!message.includes('fixture-')&&!message.includes('token-g')&&!message.includes('zzzzzz'), 'child bytes appeared in diagnostic');
   assert.ok(message.length<20000,'diagnostic exceeded bound');
  }
  const code=`process.${stream}.write('startup import failure fixture-');process.${stream}.write('key '+process.env.SIWC_FIXTURE_OWNER.slice(0,32));process.${stream}.write(process.env.SIWC_FIXTURE_OWNER.slice(32));process.exit(23)`;
  let message='';try {await runFixture(false,code);} catch(e){message=String(e.stack ?? e);}
  assert.ok(message.includes('startup import failure'));
  assert.ok(!message.includes('fixture-')&&!/[a-f0-9]{32}/.test(message),'split secret leaked');
 }
});

test('an active hung handler is terminated and reaped before fixture removal',async()=>{await runFixture(true);});
test('local 429 reselection and admission cases',async()=>{await runFixture();});
