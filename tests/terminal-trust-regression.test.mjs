import {test} from 'node:test';
import assert from 'node:assert/strict';
import {infer, strictInference} from '../src/upstream/inference.ts';

const request = {model:'gpt-test', messages:[{role:'user', content:'hi'}]};
const key = {kind:'api_key', token:'sk-synthetic'};
const oauth = {kind:'oauth', token:'synthetic', accountId:'synthetic', canRefresh:false};
const frame = e => `data: ${JSON.stringify(e)}\n\n`;
const response = text => new Response(text, {headers:{'content-type':'text/event-stream'}});
const finish = frame({choices:[{delta:{},finish_reason:'stop'}]});
const usage = (input,output) => frame({choices:[],usage:{prompt_tokens:input,completion_tokens:output}});
async function collect(generator) { const events=[]; for await (const e of generator) events.push(e); return events; }
async function ordinary(text) { return collect(await infer('openai',key,request,undefined,undefined,async()=>response(text))); }
async function strict(text, auth=key) {
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>response(text);
  try { return await collect(await strictInference('openai',auth,request)()); }
  finally { globalThis.fetch=previous; }
}

test('ordinary conflicting usage frames do not produce trusted usage', async () => {
  const events=await ordinary(finish+usage(1,2)+usage(9,2)+'data: [DONE]\n\n');
  assert.equal(events.some(e=>e.usage),false);
});
test('strict conflicting usage frames do not produce trusted usage', async () => {
  const events=await strict(finish+usage(1,2)+usage(9,2)+'data: [DONE]\n\n');
  assert.equal(events.some(e=>e.usage),false);
});
test('identical usage frames remain usable', async () => {
  for (const read of [ordinary,strict]) {
    const events=await read(finish+usage(1,2)+usage(1,2)+'data: [DONE]\n\n');
    assert.deepEqual(events.find(e=>e.usage)?.usage,{input:1,output:2});
  }
});
test('aborted stream after terminal rejects without waiting for stalled read or cancel', async () => {
  let cancelled=0, ready;
  const pendingRead=new Promise(resolve=>{ready=resolve;});
  const stream=new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(finish+'data: [DONE]\n\n')); }, cancel() { cancelled++; return new Promise(()=>{}); }});
  const getReader=stream.getReader.bind(stream);
  stream.getReader=()=>{ const reader=getReader(), read=reader.read.bind(reader); let calls=0; reader.read=()=>{ const result=read(); if (++calls===2) ready(); return result; }; return reader; };
  const controller=new AbortController();
  const generator=await infer('openai',key,request,undefined,controller.signal,async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));
  const first=await generator.next();
  assert.equal(first.value.finish,'stop');
  const result=collect(generator).then(()=> 'success',()=> 'error');
  let timer;
  try {
    const reached=await Promise.race([pendingRead.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
    clearTimeout(timer);
    assert.equal(reached,true,'parser did not reach the post-terminal read');
    controller.abort();
    const outcome=await Promise.race([result,new Promise(resolve=>{timer=setTimeout(()=>resolve('hung'),100);})]);
    assert.equal(outcome,'error');
    assert.equal(cancelled,1);
  } finally { clearTimeout(timer); }
});

test('trailing data after terminal fails instead of publishing usage', async () => {
  for (const read of [ordinary,strict]) {
    await assert.rejects(()=>read(finish+usage(1,2)+'data: [DONE]\n\n'+usage(9,2)));
  }
});

test('invalid usage cannot be repaired by a later valid usage', async () => {
  for (const read of [ordinary,strict]) {
    const events=await read(finish+usage(-1,2)+usage(1,2)+'data: [DONE]\n\n');
    assert.equal(events.some(e=>e.usage),false);
  }
});

test('strict responses reject contradictory completed details', async () => {
  for (const details of [{error:{code:'x'}},{incomplete_details:{reason:'x'}}]) {
    const text=frame({type:'response.created',response:{id:'a',status:'in_progress'}})+frame({type:'response.completed',response:{id:'a',status:'completed',...details}});
    await assert.rejects(()=>strict(text,oauth));
  }
});
test('strict responses accept matching created and clean completed response', async () => {
  const text=frame({type:'response.created',response:{id:'a',status:'in_progress'}})+frame({type:'response.completed',response:{id:'a',status:'completed',error:null,incomplete_details:null,usage:{input_tokens:2,output_tokens:3}}});
  const events=await strict(text,oauth);
  assert.deepEqual(events.at(-1),{id:'a',finish:'stop',usage:{input:2,output:3}});
});

test('strict responses reject mismatched created and completed ids', async () => {
  const text=frame({type:'response.created',response:{id:'a',status:'in_progress'}})+frame({type:'response.completed',response:{id:'b',status:'completed'}});
  await assert.rejects(()=>strict(text,oauth));
});
