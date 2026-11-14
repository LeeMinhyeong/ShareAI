import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const dir=mkdtempSync(path.join(process.env.TMPDIR,'stream-output-http-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${path.join(dir,'db.sqlite')}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',LOG_PRETTY:'false'});
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {UserRepository}=await import('../src/db/repositories/users.ts');
const {hashApiKey}=await import('../src/utils/encryption.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb(), repo=new AccountRepository();
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'),name:'fixture',email:'fixture@example.invalid',tier:'pro',dailyLimit:100});
let handling, body='', calls=0;
const provider=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(200,{'content-type':'text/event-stream'});if(typeof body==='function') body(res); else res.end(body)});
provider.listen(0,'127.0.0.1');await once(provider,'listening');assert.notEqual(provider.address().port,20128);
const app=express();app.use(express.json());app.post('/v1/chat/completions',authenticateUser,(req,res)=>{handling=forwardChat(req,res)});
const server=app.listen(0,'127.0.0.1');await once(server,'listening');assert.notEqual(server.address().port,20128);
const nativeFetch=globalThis.fetch;globalThis.fetch=(_url,opts)=>nativeFetch(`http://127.0.0.1:${provider.address().port}/`,opts);
const event=x=>`data: ${JSON.stringify(x)}\n\n`;
const oa=delta=>event({id:'chat-1',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})+event({id:'chat-1',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
const an=(content=[],block=true)=>event({type:'message_start',message:{id:'msg-1',type:'message',role:'assistant',content,usage:{input_tokens:2}}})+(block?event({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}})+event({type:'content_block_stop',index:0}):'')+event({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}})+event({type:'message_stop'});
function request(model,stream=false,onData=()=>{}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{let text='';res.setEncoding('utf8');res.on('data',x=>{text+=x;onData(text)});res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end(JSON.stringify({model,messages:[{role:'user',content:'hello'}],stream,router_options:{strategy:'priority'}}));});}
async function run(providerName,stream,expected,rested,streaming=false,onData=()=>{}){
 const a=repo.create({name:`fixture-${calls}`,provider:providerName,credentialType:'api_key',credentials:providerName==='openai'?'sk-fixture':'sk-ant-api-fixture'});body=stream;const before=calls;
 try {const r=await request(providerName==='openai'?'gpt-5':'claude-sonnet-4',streaming,onData);await handling;assert.equal(calls,before+1);assert.equal(r.status,expected, r.text);assert.equal(db.prepare('SELECT 1 FROM ordinary_account_attempts WHERE account_id=?').get(a.id),undefined,'no OPEN remains');assert.equal(Number(db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(a.id)?.duration_ms ?? 0),rested?60000:0,'a 2xx response the router cannot relay rests the account for 60s (ADR 0008, 2026-11-13)');if(streaming)assert.deepEqual(db.prepare('SELECT success,error FROM usage_logs WHERE upstream_account_id=?').all(a.id),[{success:rested?0:1,error:null}]);return r;}
 finally {repo.update(a.id,{status:'disabled'});}
}
after(async()=>{globalThis.fetch=nativeFetch;server.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>provider.close(r))]);closeDatabase();rmSync(dir,{recursive:true,force:true})});

test('OpenAI audio delta is not silently settled', {timeout:10000},async()=>{await run('openai',oa({audio:{id:'audio-1',data:'AAAA'}}),502,true)});
test('Anthropic initial tool content is not silently settled', {timeout:10000},async()=>{await run('anthropic',an([{type:'tool_use',id:'tool-1',name:'run',input:{}}]),502,true)});
test('Anthropic documented empty end_turn settles', {timeout:10000},async()=>{const r=await run('anthropic',an([],false),200,false);assert.equal(JSON.parse(r.text).choices[0].message.content,'')});
test('OpenAI choice logprobs and unknown output fail closed', {timeout:10000},async()=>{for(const extra of [{logprobs:{content:[{token:'x',logprob:-1}]}},{future_output:'lost'}]) {const s=event({choices:[{index:0,delta:{content:'hello'},finish_reason:null,...extra}]})+event({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';await run('openai',s,502,true)}});
test('streaming partial output followed by unsupported output reports error and rests the account', {timeout:10000},async()=>{let release,observed=false;const s=res=>{res.write(event({choices:[{index:0,delta:{content:'partial'},finish_reason:null}]}));const timer=setTimeout(()=>res.destroy(),3000);release=()=>{clearTimeout(timer);res.end(event({choices:[{index:0,delta:{},finish_reason:'stop',logprobs:{content:[]}}]})+'data: [DONE]\n\n')}};const r=await run('openai',s,200,true,true,text=>{if(!observed&&text.includes('partial')){observed=true;release()}});assert.equal(observed,true);assert.match(r.text,/partial/);assert.match(r.text,/error/);assert.doesNotMatch(r.text,/\[DONE\]/)});
test('streaming positive control delivers text and DONE', {timeout:10000},async()=>{const r=await run('openai',oa({content:'hello'}),200,false,true);assert.match(r.text,/hello/);assert.match(r.text,/\[DONE\]/)});
test('cancelled ordinary stream logs failure, never success', {timeout:10000},async()=>{
 const a=repo.create({name:'cancel',provider:'openai',credentialType:'api_key',credentials:'sk-fixture'});let upstream;
 body=res=>{upstream=res;res.write(event({choices:[{index:0,delta:{content:'partial'},finish_reason:null}]}));};
 try {
  await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'}},res=>{res.on('data',chunk=>{if(String(chunk).includes('partial')) {res.destroy();resolve();}});res.on('error',()=>{});});req.on('error',reject);req.end(JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hello'}],stream:true}));});
  await handling;assert.deepEqual(db.prepare('SELECT success,error FROM usage_logs WHERE upstream_account_id=?').all(a.id),[{success:0,error:null}]);
 } finally {upstream?.destroy();repo.update(a.id,{status:'disabled'});}
});
test('OpenAI unknown output and wrong role are rejected', {timeout:10000},async()=>{for(const delta of [{future_output:{data:'x'}},{role:'user'},{tool_calls:[{index:0}]},{function_call:{name:'x'}},{refusal:'no'}]) await run('openai',oa(delta),502,true)});
test('Anthropic initial text and malformed content are rejected', {timeout:10000},async()=>{for(const content of [[{type:'text',text:'lost'}],null,{}]) await run('anthropic',an(content),502,true)});
test('Anthropic unsupported block data is not silently discarded', {timeout:10000},async()=>{await run('anthropic',an().replace('"text":"hello"','"text":"hello","extra_output":"lost"'),502,true)});
test('OpenAI standard role and content are delivered', {timeout:10000},async()=>{const r=await run('openai',oa({role:'assistant',content:'hello',refusal:null,tool_calls:null,function_call:null}),200,false);assert.match(r.text,/hello/)});
test('Anthropic standard text block is delivered', {timeout:10000},async()=>{const r=await run('anthropic',an(),200,false);assert.match(r.text,/hello/)});
