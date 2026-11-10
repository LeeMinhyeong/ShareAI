import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--worker') {
  const { infer, UpstreamError, isSiwcStream429 } = await import('../src/upstream/inference.ts');
  // Best-effort disposal (ADR 0017) must still handle a late cancel rejection.
  process.on('unhandledRejection', error => { console.error('unhandled rejection', error); process.exit(3); });
  const encode = new TextEncoder();
  const request = {model:'synthetic', messages:[{role:'user',content:'hi'}]};
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const failed = {type:'response.failed',sequence_number:0,response:{id:'r',status:'failed',error:{code:'subscription_sharing_usage_limit_exceeded',message:'limit'}}};
  let calls = 0;
  let rejectCancel;
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encode.encode(frame(failed))); },
    cancel() { cancelled++; process.send('cancel-started'); return new Promise((_, reject) => { rejectCancel = reject; }); },
  });
  const events = await infer('openai', {kind:'siwc',token:'synthetic'}, request, undefined, undefined,
    async () => { calls++; return new Response(body, {headers:{'content-type':'text/event-stream'}}); });
  let caught;
  try { for await (const event of events) assert.fail(`unexpected event ${JSON.stringify(event)}`); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof UpstreamError);
  assert.equal(caught.status, 429);
  assert.equal(isSiwcStream429(caught), true);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  rejectCancel(new Error('synthetic cancel failure'));
  await new Promise(resolve => setImmediate(resolve));

  // A similar but untrusted envelope must remain unbranded (502, so the route retains its
  // uncertain OPEN fence) and must still start cancellation. Disposal is best effort: a stalled
  // cancel cannot delay the outcome (inference.ts), so the error surfaces while cancel is pending.
  let releaseUnknown, unknownCancel;
  const unknownCancelled = new Promise(resolve => { unknownCancel = resolve; });
  const unknownBody = new ReadableStream({
    start(controller) { controller.enqueue(encode.encode(frame({...failed, extra:true}))); },
    cancel() { unknownCancel(); return new Promise(resolve => { releaseUnknown = resolve; }); },
  });
  const unknownEvents = await infer('openai', {kind:'siwc',token:'synthetic'}, request, undefined, undefined,
    async () => { calls++; return new Response(unknownBody, {headers:{'content-type':'text/event-stream'}}); });
  let unknownSettled = false;
  const unknownResult = unknownEvents.next().then(() => { throw new Error('untrusted stream succeeded'); }, error => error)
    .then(value => { unknownSettled = true; return value; });
  await unknownCancelled;
  const unknown = await unknownResult;
  assert.equal(unknownSettled, true, 'outcome not blocked by the stalled cancel');
  releaseUnknown();
  assert.ok(unknown instanceof UpstreamError);
  assert.equal(unknown.status, 502);
  assert.equal(isSiwcStream429(unknown), false);
  assert.equal(calls, 2);

  // A consumer return after emitted text starts stream cancellation without waiting on it.
  let releaseReturn, returnCancel;
  const returnCancelled = new Promise(resolve => { returnCancel = resolve; });
  const prefix = [
    {type:'response.created',response:{id:'r',status:'in_progress'}},
    {type:'response.output_item.added',output_index:0,item:{id:'m',type:'message',role:'assistant',status:'in_progress',content:[]}},
    {type:'response.content_part.added',item_id:'m',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',item_id:'m',output_index:0,content_index:0,delta:'partial'},
  ].map(frame).join('');
  const partialBody = new ReadableStream({
    start(controller) { controller.enqueue(encode.encode(prefix)); },
    cancel() { returnCancel(); return new Promise(resolve => { releaseReturn = resolve; }); },
  });
  const partial = await infer('openai', {kind:'siwc',token:'synthetic'}, request, undefined, undefined,
    async () => { calls++; return new Response(partialBody, {headers:{'content-type':'text/event-stream'}}); });
  assert.deepEqual(await partial.next(), {value:{text:'partial'},done:false});
  let returned = false;
  const returning = partial.return().then(value => { returned = true; return value; });
  assert.equal((await returning).done, true);
  await returnCancelled;
  assert.equal(returned, true);
  releaseReturn();
  assert.equal(calls, 3);
  process.send('complete');
  process.disconnect();
} else {
  test('validated SIWC stream 429 reaches caller despite unresolved cancellation', async () => {
    const child = fork(fileURLToPath(import.meta.url), ['--worker'], {execArgv:['--import',import.meta.resolve('tsx')], stdio:['ignore','pipe','pipe','ipc']});
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let ready = false, completed = false, timedOut = false;
    const startup = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    let deadline;
    child.on('message', message => {
      if (message === 'cancel-started') {
        ready = true; clearTimeout(startup);
        deadline = setTimeout(() => { timedOut = true; child.kill(); }, 1500);
      }
      if (message === 'complete') completed = true;
    });
    const closed = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
    });
    clearTimeout(startup); clearTimeout(deadline);
    assert.equal(ready, true, `fixture did not reach cancel: ${output}`);
    assert.equal(timedOut, false, `caller remained blocked after cancellation began: ${output}`);
    assert.equal(completed, true, `worker did not complete: ${output}`);
    assert.equal(closed.code, 0, `worker failed: ${output}`);
  });
}
