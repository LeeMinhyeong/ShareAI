import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual inference module in memory; fetch is a synthetic provider.
const source = readFileSync(new URL('../src/upstream/inference.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
let wire;
const exports = {};
vm.runInNewContext(code, {exports, TextDecoder, fetch:async () => new Response(wire, {headers:{'content-type':'text/event-stream'}}), require() { throw new Error('Unexpected import'); }});
const request = {model:'synthetic', messages:[{role:'user',content:'hello'}]};
const auth = {kind:'api_key',token:'sk-synthetic'};
const frame = x => `data: ${JSON.stringify(x)}\n\n`;
const chunk = (id, delta, finish_reason=null) => ({...(id === undefined ? {} : {id}), choices:[{index:0,delta,finish_reason}]});
const usage = id => ({...(id === undefined ? {} : {id}),choices:[],usage:{prompt_tokens:0,completion_tokens:0}});
async function run(mode, frames) {
  wire = frames.map(frame).join('') + 'data: [DONE]\n\n';
  const generator = mode === 'production' ? await exports.infer('openai',auth,request) : await exports.strictInference('openai',auth,request)();
  const events = [];
  for await (const event of generator) events.push(JSON.parse(JSON.stringify(event)));
  return events;
}
for (const mode of ['production','strict']) {
  test(`${mode} rejects mismatched IDs before yielding the offending frame`, async () => {
    wire = [chunk('first',{content:'ok'}),chunk('second',{content:'wrong'},'stop')].map(frame).join('') + 'data: [DONE]\n\n';
    const generator = mode === 'production' ? await exports.infer('openai',auth,request) : await exports.strictInference('openai',auth,request)();
    const received = [];
    await assert.rejects(async () => { for await (const event of generator) received.push(event); }, e => e.status === 502);
    assert.equal(received.some(e => e.text === 'wrong' || e.finish || e.usage),false);
  });
  test(`${mode} rejects mismatched usage-frame ID`, async () => {
    await assert.rejects(run(mode,[chunk('first',{content:'ok'}),chunk('first',{},'stop'),usage('other')]), e => e.status === 502);
  });
  test(`${mode} accepts stable and omitted IDs and retains known zero usage`, async () => {
    for (const id of ['same',undefined]) {
      const result = await run(mode,[chunk(id,{content:'ok'}),chunk(id,{},'stop'),usage(id)]);
      assert.equal(result.find(e=>e.text)?.text,'ok');
      assert.equal(result.find(e=>e.finish)?.finish,'stop');
      assert.deepEqual(result.find(e=>e.usage)?.usage,{input:0,output:0});
    }
  });
  test(`${mode} leaves partial token usage unknown`, async () => {
    const partial = {id:'same',choices:[],usage:{prompt_tokens:5}};
    const result = await run(mode,[chunk('same',{content:'ok'}),chunk('same',{},'stop'),partial]);
    assert.equal(result.some(e => e.usage !== undefined),false);
  });
}
