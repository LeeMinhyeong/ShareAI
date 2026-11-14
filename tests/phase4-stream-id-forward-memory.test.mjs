import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript'), express = require('express'), Database = require('better-sqlite3');
function load(path, deps = {}, onIdGuard) {
  let text = readFileSync(new URL(path, import.meta.url), 'utf8');
  if (onIdGuard) {
    const guard = "if (typeof e.id !== 'string' || (responseId !== undefined && e.id !== responseId)) fail();";
    assert.equal(text.split(guard).length, 2, 'expected exactly one OpenAI streaming ID guard');
    text = text.replace(guard, "if (typeof e.id !== 'string' || (responseId !== undefined && e.id !== responseId)) { onIdGuard(); fail(); }");
  }
  const source = ts.transpileModule(text, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require,onIdGuard){${source}\n})`)(exports, name => {
    if (!Object.hasOwn(deps,name)) throw Error('Unexpected dependency: '+name);
    return deps[name];
  }, onIdGuard);
  return exports;
}
function response() {
  let done; const ended = new Promise(resolve => done = resolve);
  const res = Object.assign(new EventEmitter(), {statusCode:200, headersSent:false, writableEnded:false, destroyed:false, headers:{}, body:'',
    setHeader(k,v){this.headers[k.toLowerCase()]=v;}, getHeader(k){return this.headers[k.toLowerCase()];},
    write(s){this.headersSent=true;this.body+=s;return true;},
    end(s=''){this.headersSent=true;this.body+=s;this.writableEnded=true;done();},
    status(n){this.statusCode=n;return this;}, json(x){this.end(JSON.stringify(x));return this;}, destroy(){this.destroyed=true;done();}
  });
  return {res,ended};
}
async function bounded(promise) {
  let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture timeout')),3000);})]); }
  finally {clearTimeout(timer);}
}
const frame = x => `data: ${JSON.stringify(x)}\n\n`;
const chunk = (id,content,finish=null) => ({id,choices:[{index:0,delta:content===null?{}:{content},finish_reason:finish}]});
function events(res) {
  assert.equal(res.statusCode,200);
  assert.equal(res.getHeader('Content-Type'),'text/event-stream');
  assert.ok(res.body.endsWith('\n\n'));
  return res.body.slice(0,-2).split('\n\n').map(s => {
    assert.ok(s.startsWith('data: '));
    const data=s.slice(6);
    if (data==='[DONE]') return data;
    try { return JSON.parse(data); } catch { throw Error('invalid SSE JSON'); }
  });
}
function expectedChunks(actual, text, finish) {
  const first=actual[0];
  assert.equal(typeof first?.id==='string' && /^chatcmpl-[0-9a-f-]+$/.test(first.id),true,'invalid response ID');
  assert.ok(Number.isInteger(first.created));
  const common={id:first.id,object:'chat.completion.chunk',created:first.created,model:'gpt-5'};
  const item=(delta,reason=null)=>({...common,choices:[{index:0,delta,finish_reason:reason}]});
  return [item({role:'assistant'}),item({content:text}),...(finish ? [item({},'stop'),'[DONE]'] : [{error:{type:'upstream_error',message:'Malformed or incomplete upstream stream'}}])];
}
function assertSequence(actual, text, finish) {
  assert.equal(JSON.stringify(actual)===JSON.stringify(expectedChunks(actual,text,finish)),true,'unexpected SSE sequence');
}

// OpenAI's generated SDK specifies ChatCompletionChunk.id as a string shared by
// all chunks: https://raw.githubusercontent.com/openai/openai-node/main/src/resources/chat/completions/completions.ts
// This router allows omitted IDs but requires any present IDs to be strings and
// consistent. Other compatible providers need not make the same guarantee;
// this synthetic ordinary OpenAI-protocol test does not exercise Codex SIWC.
test('authenticated streaming rejects a non-string response id after emitted text, resting the account', {timeout:10000}, async () => {
  const db = new Database(':memory:'); const nativeFetch = globalThis.fetch;
  let manager, drained=false;
  try {
    db.exec(`CREATE TABLE upstream_accounts(id TEXT PRIMARY KEY,status TEXT,state_revision INTEGER,credential_revision INTEGER,daily_quota INTEGER);
      CREATE TABLE account_429_cooldowns(kind TEXT,account_id TEXT,until_at INTEGER);
      CREATE TABLE account_daily_reservations(account_id TEXT PRIMARY KEY,day TEXT,used INTEGER,legacy_ambiguous INTEGER);
      CREATE TABLE ordinary_account_attempts(account_id TEXT PRIMARY KEY,attempt_id TEXT);`);
    // Real v2 restriction store and schema (no runtime imports), as production uses.
    const v2=load('../src/db/account-429-v2-store.ts', {}); db.transaction(() => v2.provision429V2(db)).immediate();
    const ordinaryDeadline=load('../src/upstream/ordinary-429-deadline.ts', {});
    db.prepare('INSERT INTO upstream_accounts VALUES (?,?,?,?,?)').run('synthetic-account','active',1,1,0);
    const account={id:'synthetic-account',provider:'openai',credentialType:'api_key',credentials:'synthetic',stateRevision:1,credentialRevision:1};
    const logger={debug(){},warn(){},error(){}};
    const writer={withAsyncWriter:async fn=>db.transaction(()=>fn(db)).immediate()};
    // Test-owned observation only; it does not change the guard or its failure.
    let idGuardHits=0;
    const inference=load('../src/upstream/inference.ts', {}, ()=>{idGuardHits++;});
    const quota=load('../src/upstream/account-quota.ts', {'../db/account-429-v2-store.js':v2,'../db/async-writer.js':writer,'../db/durable-ledger-foundation.js':{},'./inference.js':inference,'./oauth.js':{parseStoredCredentials:()=>undefined},'../db/repositories/accounts.js':{},crypto:require('crypto')});
    let successes=0, fetches=0, forwards=0, quotaCharges=0, selected;
    const pool={selectCandidate:async()=>(selected={kind:'upstream',account}),recordSuccessAsync:async()=>{successes++;},recordFailureAsync:async()=>{}};
    const user={id:'synthetic-user',name:'Synthetic',email:'fixture@example.invalid',tier:'pro',dailyLimit:10};
    const users={UserRepository:class {reserveDailyQuota(hash){if(hash!=='synthetic-hash') return {user:undefined};quotaCharges++;return {user,allowed:true,used:quotaCharges};}}};
    const work=load('../src/request-work.ts',{'node:async_hooks':require('node:async_hooks')}); manager=new work.RequestWorkManager();
    const auth=load('../src/auth/user-auth.ts',{'../db/repositories/users.js':users,'../utils/encryption.js':{hashApiKey:key=>key==='synthetic-client-key'?'synthetic-hash':'invalid'},'../utils/logger.js':{logger},'../config/env.js':{env:{}},'../db/async-writer.js':writer,'../request-work.js':{requestWork:manager}});
    const forward=load('../src/upstream/forward-chat.ts',{'./passthrough.js':{parsePassthrough(){throw new Error('passthrough unused');},startPassthrough(){throw new Error('passthrough unused');},PassthroughHttpError:class extends Error{},PassthroughStreamFailure:class extends Error{},routerErrorBody:()=>({}),routerErrorFrame:()=>''},'../db/account-429-v2-store.js':v2,'./ordinary-429-deadline.js':ordinaryDeadline,'crypto':require('crypto'),'events':require('events'),'../account-pool/manager.js':{accountPool:pool},'../db/repositories/usage-logs.js':{UsageLogRepository:class {create(){}}},'../db/repositories/accounts.js':{RefreshIntentError:class extends Error {}},'../utils/logger.js':{logger},'./tokens.js':{resolveAuth:async()=>({kind:'api_key',token:'sk-synthetic-token',observedAccount:account})},'./inference.js':inference,'./account-quota.js':quota,'../db/client.js':{getDb:()=>db},'../db/async-writer.js':writer,'../utils/encryption.js':{CredentialVault:class {}},'./siwc-store.js':{},'./siwc-refresh.js':{},'../db/repositories/settings.js':{SettingsRepository:class {},STRATEGIES:['priority']}});
    let pending, dispatched;
    const openRows=()=>db.prepare('SELECT account_id,attempt_id FROM ordinary_account_attempts').all();
    const restrictionMs=()=>db.prepare("SELECT duration_ms FROM account_429_v2_restrictions WHERE kind='upstream' AND account_id=?").get(account.id)?.duration_ms;
    const router=load('../src/routes/v1.ts',{'../config/env.js':{env:{NODE_ENV:'test'}},'express':express,'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},'../utils/logger.js':{logger},'../upstream/forward-chat.js':{forwardMessages(_req,res){res.status(501).json({error:{type:'not_implemented',message:'fixture'}});},forwardResponses(_req,res){res.status(501).json({error:{type:'not_implemented',message:'fixture'}});},anthropicErrorEnvelope(){},anthropicErrorBody:(_s,message)=>({type:'error',error:{type:'api_error',message}}),forwardChat:(req,res)=>{forwards++;return pending=forward.forwardChat(req,res);}}}).default;
    async function request(payload,key='synthetic-client-key') {
      dispatched=undefined;
      globalThis.fetch=async()=>{fetches++; const rows=openRows(); assert.equal(rows.length,1); assert.equal(selected.account.id,rows[0].account_id); dispatched={kind:selected.kind,...rows[0]}; return new Response(payload,{headers:{'content-type':'text/event-stream'}});};
      const {res,ended}=response();
      router.handle({method:'POST',url:'/chat/completions',headers:{authorization:`Bearer ${key}`},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],stream:true,router_options:{strategy:'priority'}}},res,()=>res.status(404).json({}));
      await bounded(ended); if (pending) await bounded(pending); return res;
    }
    const invalid=await request('', 'invalid'); assert.equal(invalid.statusCode,401); assert.equal(fetches,0); assert.equal(forwards,0); assert.equal(quotaCharges,0);
    const invalidIds = [null, 17, false, {}, 'response-other'];
    for (const id of invalidIds) {
      const malformed=frame(chunk('response-a','visible'))+frame(chunk(id,null,'stop'))+'data: [DONE]\n\n';
      const before=idGuardHits;
      const bad=await request(malformed);
      assert.equal(idGuardHits,before+1,'specific ID guard must reject this event');
      const actual=events(bad);
      assertSequence(actual,'visible',false);
      assert.equal(bad.body.includes('synthetic-client-key'),false,'response must not expose client credential');
      assert.equal(bad.body.includes('sk-synthetic-token'),false,'response must not expose upstream credential');
      assert.equal(dispatched.kind,'upstream'); assert.equal(dispatched.account_id,account.id); assert.match(dispatched.attempt_id,/^[0-9a-f-]{36}$/);
      assert.deepEqual(openRows(),[],'OPEN converted'); assert.equal(Number(restrictionMs()),60000,'a broken 2xx stream rests the account for 60s (ADR 0008, 2026-11-13)');
      assert.equal(successes,0);
      // Clear the 60s restriction only on this owned in-memory fixture so the next case can dispatch.
      db.prepare('DELETE FROM account_429_v2_restrictions').run();
    }
    assert.equal(fetches,invalidIds.length); assert.equal(quotaCharges,invalidIds.length);
    // An unrelated malformed event has the same public error but must not hit the ID guard.
    const beforeOther=idGuardHits;
    const other=await request(frame(chunk('response-a','visible'))+frame({id:'response-a',choices:'invalid'}));
    assert.equal(idGuardHits,beforeOther);
    const otherEvents=events(other);
    assertSequence(otherEvents,'visible',false);
    assert.deepEqual(openRows(),[],'OPEN converted'); assert.equal(Number(restrictionMs()),60000,'a broken 2xx stream rests the account for 60s (ADR 0008, 2026-11-13)');
    db.prepare('DELETE FROM account_429_v2_restrictions').run();
    const good=await request(frame(chunk('response-b','ok'))+frame(chunk('response-b',null,'stop'))+'data: [DONE]\n\n');
    const goodEvents=events(good);
    assertSequence(goodEvents,'ok',true);
    assert.equal(idGuardHits,beforeOther);
    assert.equal(dispatched.kind,'upstream'); assert.equal(dispatched.account_id,account.id); assert.match(dispatched.attempt_id,/^[0-9a-f-]{36}$/);
    assert.equal(successes,1); assert.equal(fetches,invalidIds.length+2); assert.equal(quotaCharges,invalidIds.length+2);
    assert.deepEqual(openRows(),[]);
    const withoutId = {choices:[{index:0,delta:{},finish_reason:'stop'}]};
    const noId=await request(frame(chunk('response-c','ok'))+frame(withoutId)+'data: [DONE]\n\n');
    const noIdEvents=events(noId);
    assertSequence(noIdEvents,'ok',true); assert.equal(successes,2); assert.equal(idGuardHits,beforeOther); assert.deepEqual(openRows(),[]);
    await bounded(manager.stopAndDrain()); drained=true;
  } finally {globalThis.fetch=nativeFetch; if (manager&&!drained) await bounded(manager.stopAndDrain()); db.close();}
});
