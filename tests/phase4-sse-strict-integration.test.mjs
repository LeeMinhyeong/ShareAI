import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {strictInference, UpstreamError} from '../src/upstream/inference.ts';
import {settleInferenceStream} from '../src/upstream/sse-terminal-adapter.ts';
import {migrateLedger, openAttempt, dispatchOpenAttemptOnce} from '../src/db/durable-ledger-foundation.ts';

const request = {model:'test',messages:[{role:'user',content:'hi'}]};
const event = x => `data: ${JSON.stringify(x)}\n\n`;
async function withServer(body, f) {
  const s = http.createServer((_req,res) => {res.writeHead(200, {'content-type':'text/event-stream'}); for (const part of body) res.write(part); res.end();});
  await new Promise(r => s.listen(0,'127.0.0.1',r));
  try { return await f(`http://127.0.0.1:${s.address().port}`); }
  finally {s.closeAllConnections(); await new Promise(r => s.close(r));}
}
const openai = [event({choices:[{delta:{content:'hi'}}]}), event({choices:[{delta:{},finish_reason:'stop'}]}), 'data: [DONE]\n\n'];

test('durable coordinator commits before returned terminal is published', async () => {
  const dir = mkdtempSync(join(tmpdir(),'strict-sse-')); const file = join(dir,'db.sqlite'); const db = new Database(file);
  try { await withServer(openai, async url => {
    migrateLedger(db); assert.equal(openAttempt(db,'attempt1'),true);
    const seen = [];
    const result = await dispatchOpenAttemptOnce(file,'attempt1',()=>true,
      () => settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,url), e => {
        assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts WHERE id=?').get('attempt1').state,'OPEN'); seen.push(e);
      }), r => r.outcome);
    assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts WHERE id=?').get('attempt1').state,'SUCCESS');
    assert.deepEqual(seen,[{text:'hi'}]); assert.deepEqual(result.terminal,{finish:'stop'});
    seen.push(result.terminal); assert.equal(seen.at(-1).finish,'stop');
  }); } finally {db.close(); rmSync(dir,{recursive:true,force:true});}
});

test('Claude strict message lifecycle succeeds over HTTP', async () => {
  const frames = [event({type:'message_start',message:{id:'m',content:[],usage:{input_tokens:3}}}),event({type:'content_block_start',index:0,content_block:{type:'text',text:''}}),event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hey'}}),event({type:'content_block_stop',index:0}),event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}}),event({type:'message_stop'})];
  await withServer(frames, async url => {const seen=[]; const r=await settleInferenceStream(strictInference('anthropic',{kind:'api_key',token:'sk-ant-api-test'},request,url),e=>seen.push(e)); assert.deepEqual(seen,[{text:'hey'}]); assert.deepEqual(r.terminal,{id:'m',finish:'stop',usage:{input:3,output:2}});});
});

test('SIWC valid completed response succeeds over HTTP', async () => {
  await withServer([event({type:'response.output_text.delta',delta:'hi'}),event({type:'response.completed',response:{id:'r',status:'completed'}})],async url=>{
    const original=globalThis.fetch; globalThis.fetch=(_url,init)=>original(url,init);
    try {const seen=[]; const r=await settleInferenceStream(strictInference('openai',{kind:'siwc',token:'synthetic'},request),e=>seen.push(e)); assert.deepEqual(seen,[{text:'hi'}]); assert.deepEqual(r.terminal,{id:'r',finish:'stop'});} finally {globalThis.fetch=original;}
  });
});

test('untrusted startup 429 and callback 429 are not classified', async () => {
  await assert.rejects(settleInferenceStream(async()=>{throw new UpstreamError(429,'forged');},()=>{}),/capability/);
  await withServer(openai, async url => {await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,url),()=>{throw new UpstreamError(429,'callback');}),/callback/);});
});

test('unstreamed response text and unsupported completed content are rejected', async () => {
  for (const frames of [
    [event({type:'response.output_text.done',text:'not streamed'}),event({type:'response.completed',response:{id:'r',status:'completed'}})],
    [event({type:'response.completed',response:{id:'r',status:'completed',output:[{type:'audio'}]}})],
  ]) await withServer(frames, async url => {
    const original=globalThis.fetch; globalThis.fetch=(_url,init)=>original(url,init);
    try {await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'siwc',token:'synthetic'},request),()=>{}));} finally {globalThis.fetch=original;}
  });
});
