import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// Pure helper (no imports); the real module is used rather than a stub.
const ordinaryDeadline = await import('../src/upstream/ordinary-429-deadline.ts');

const compile = file => ts.transpileModule(readFileSync(new URL(`../src/upstream/${file}.ts`, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const quotaCode = compile('account-quota'), forwardCode = compile('forward-chat');

function fixture(mode, fault = {}) {
  let selected = [], starts = [], writes = [], selections = [], commits = 0, open = new Set(), close, writerCalls = 0;
  const accounts = ['a','b'].map(id => ({id,provider:'openai',credentials:'synthetic',credentialType:'api_key',stateRevision:1,credentialRevision:1}));
  class UpstreamError extends Error { constructor(status, message) {super(message); this.status=status;} }
  let quota;
  const usedByAccount = {a:['exhausted','commit','rollback','cancel','cancel-after-commit','lost-ack','refresh'].includes(mode) ? 1 : 0,b:0};
  const db = {prepare(sql) {
    if (sql.includes('SELECT status, state_revision')) return {get: () => ({status:'active',state_revision:1,credential_revision:1,daily_quota:1})};
    if (sql.includes('account_429_cooldowns')) return {get: id => mode === 'cooldown' && id === 'a' ? 1 : undefined};
    // The admission cooldown is the v2 restriction (ADR 0008); 'cooldown' mode restricts A there.
    if (sql.includes('account_429_v2_restrictions')) return {get: (kind, id) => mode === 'cooldown' && kind === 'upstream' && id === 'a' ? 1 : undefined, run: () => ({changes:1})};
    if (sql.includes('SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=? AND attempt_id=?')) return {get: id => open.has(id) ? 1 : undefined};
    if (sql.includes('SELECT 1 FROM main.ordinary_account_attempts')) return {get: id => open.has(id) ? 1 : undefined};
    if (sql.includes('SELECT day,used,legacy_ambiguous')) return {get: id => {if (mode === 'dependency') throw new quota.AccountQuotaExhausted(); return {day:new Date().toISOString().slice(0,10),used:usedByAccount[id],legacy_ambiguous:0};}};
    if (sql.includes('UPDATE account_daily_reservations')) return {run: id => {writes.push(`reservation:${id}`);usedByAccount[id]++;}};
    if (sql.includes('INSERT INTO main.ordinary_account_attempts')) return {run: id => {writes.push(`open:${id}`);open.add(id);}};
    if (sql.includes('DELETE FROM main.ordinary_account_attempts')) return {run: id => {open.delete(id);return {changes:1};}};
    throw new Error(`unexpected SQL: ${sql}`);
  }};
  if (mode === 'open') open.add('a');
  const writer = fn => {
    writerCalls++;
    if (fault.where === 'rollback' && writerCalls === fault.call) { try { fn(db); throw new Error('synthetic rollback'); } catch { throw new quota[fault.kind](); } }
    if (mode === 'rollback' && commits === 0) { try { fn(db); throw new Error('synthetic rollback needed'); } catch { throw new quota.AccountQuotaExhausted(); } }
    const result = fn(db);
    if (fault.where === 'commit' && writerCalls === fault.call) throw new quota[fault.kind]();
    if (mode === 'commit' && commits === 0) throw new quota.AccountQuotaExhausted();
    commits++;
    if (mode === 'lost-ack' && commits === 1) throw new quota.AccountQuotaExhausted();
    if ((mode === 'cancel-after-commit' || fault.cancelAfterCommit) && commits === 1) close();
    return result;
  };
  const context = {Promise,Date,Number,Response,AbortController,setTimeout,clearTimeout,process,console};
  const common = name => {
    if (name === '../db/async-writer.js') return {withAsyncWriter:writer};
    // No v2 restriction in this fixture; the real schema check needs a real database.
    if (name === '../db/account-429-v2-store.js') return {assert429V2Schema() {}, arm429V2() {}};
    if (name === './ordinary-429-deadline.js') return ordinaryDeadline;
    if (name === './inference.js') return {UpstreamError, infer:async (_p,auth,_r,_x,_s,invoke) => { if (mode === 'generic') throw new quota.AccountQuotaExhausted(); if (fault.where === 'before-provider') throw new quota[fault.kind](); await invoke(() => { starts.push(auth.observedAccount.id); if (fault.where === 'provider') throw new quota[fault.kind](); if (mode === 'provider') throw new quota.AccountQuotaExhausted(); if (mode === 'provider-async') return Promise.reject(new quota.AccountQuotaExhausted()); return Promise.resolve(new Response()); }); return (async function*(){ yield {text:'ok'}; })(); }, isSiwcStream429:()=>false};
    if (name === './passthrough.js') return {parsePassthrough(){throw new Error('passthrough unused');},startPassthrough(){throw new Error('passthrough unused');},PassthroughHttpError:class extends Error{},PassthroughStreamFailure:class extends Error{},routerErrorBody:()=>({}),routerErrorFrame:()=>''};
    if (name === 'crypto') return {randomUUID:()=> 'attempt'};
    if (name === 'events') return {once:async()=>{}};
    return undefined;
  };
  function load(code, extra) { const exports = {}; vm.runInNewContext(code, {...context,exports,require:name => {const x=common(name) ?? extra(name); if (x === undefined) throw new Error(`unexpected import ${name}`); return x;}}); return exports; }
  quota = load(quotaCode, name => ({'../db/durable-ledger-foundation.js':{createOpenAttemptCallback:()=>()=>{}}, './oauth.js':{parseStoredCredentials:()=>null,decodeJwt:()=>null}, '../db/repositories/accounts.js':{refreshFingerprint:()=>'',RefreshIntentError:class extends Error {}}})[name]);
  const pool = {selectCandidate:async (_u,_m,_p,_s,opt) => {selections.push({upstream:[...opt.excludeUpstream],siwc:[...opt.excludeSiwc],credentialTypes:[...opt.credentialTypes]});const account=accounts.find(a=>!opt.excludeUpstream.has(a.id)); if (!account) return null; selected.push(account.id); return {kind:'upstream',account};},recordSuccessAsync:async()=>{},recordFailureAsync:async()=>{}};
  const forward = load(forwardCode, name => ({'./account-quota.js':quota,'../account-pool/manager.js':{accountPool:pool},'./tokens.js':{resolveAuth:async account=>({kind:'api_key',token:'synthetic',observedAccount:account,refreshConsidered:mode==='refresh' || !!fault.refresh,canRefresh:false})},'../db/repositories/usage-logs.js':{UsageLogRepository:class {create(){}}},'../db/repositories/accounts.js':{RefreshIntentError:class extends Error {}},'../utils/logger.js':{logger:{error(){}}},'../db/client.js':{getDb:()=>db},'../utils/encryption.js':{CredentialVault:class {}},'./siwc-store.js':{SiwcStore:class {}},'./siwc-refresh.js':{},'../db/repositories/settings.js':{SettingsRepository:class {getStrategy(){return 'round_robin';}},STRATEGIES:['round_robin']}})[name]);
  const req={user:{id:'user'},body:{model:'gpt-test',messages:[]}};
  const res={writableEnded:false,destroyed:false,headersSent:false,on(_event,cb){close=cb;if(mode==='cancel') cb();},status(code){this.code=code;return this;},json(value){this.body=value;this.writableEnded=true;return this;},setHeader(){},getHeader(){},end(){this.writableEnded=true;}};
  return {run:()=>forward.forwardChat(req,res),state:()=>({selected,starts,writes,selections,commits,status:res.code,body:res.body})};
}

for (const kind of ['AccountAttemptOpen','AccountCooldownBeforeDispatch']) {
  for (const [where,call] of [['before-provider',0],['provider',0],['commit',1],['commit',2],['rollback',1],['rollback',2]]) test(`${kind} from ${where} ${call} never reselects`,async()=>{
    const f=fixture('fault',{kind,where,call}); await f.run(); const s=f.state();
    assert.deepEqual(s.selected,['a']); assert.deepEqual(s.starts,(where==='provider' || call===2)?['a']:[]); assert.equal(s.status,503);
  });
}
for (const mode of ['open','cooldown']) test(`committed ${mode} selects B without A reservation or dispatch`,async()=>{
  const f=fixture(mode); await f.run(); const s=f.state(); assert.deepEqual(s.selected,['a','b']); assert.deepEqual(s.starts,['b']); assert.equal(s.writes.some(x=>x.endsWith(':a')),false); assert.deepEqual(s.selections[1],{upstream:['a'],siwc:[],credentialTypes:['oauth','api_key']}); assert.equal(s.body.choices[0].message.content,'ok');
});

for (const mode of ['open','cooldown']) for (const fault of [{refresh:true},{cancelAfterCommit:true}]) test(`${mode} respects ${fault.refresh?'refresh':'cancellation'} guard`,async()=>{
  const f=fixture(mode,fault); await f.run(); const s=f.state(); assert.equal(s.commits,1); assert.deepEqual(s.selected,['a']); assert.deepEqual(s.starts,[]); assert.deepEqual(s.writes,[]); if (fault.refresh) assert.equal(s.status,503);
});

for (const mode of ['provider','provider-async','commit','lost-ack','rollback','dependency','generic']) test(`${mode} exhaustion-shaped error never triggers reselection`, async()=>{
  const f=fixture(mode); await f.run(); const s=f.state(); assert.deepEqual(s.selected,['a']); assert.deepEqual(s.starts,mode.startsWith('provider')?['a']:[]);
  if (mode === 'lost-ack') assert.equal(s.commits,1);
});
test('confirmed read-only exhaustion selects B once without A reservation or dispatch',async()=>{
  const f=fixture('exhausted');await f.run();const s=f.state();assert.deepEqual(s.selected,['a','b']);assert.deepEqual(s.starts,['b']);assert.equal(s.writes.some(x=>x.endsWith(':a')),false);assert.equal(s.body.choices[0].message.content,'ok');
});
test('refresh consideration prevents reselection even after confirmed exhaustion',async()=>{const f=fixture('refresh');await f.run();const s=f.state();assert.equal(s.commits,1);assert.equal(s.status,503);assert.deepEqual(s.selected,['a']);assert.deepEqual(s.starts,[]);assert.deepEqual(s.writes,[]);});
test('cancellation never reselects or dispatches',async()=>{const f=fixture('cancel');await f.run();const s=f.state();assert.deepEqual(s.selected,['a']);assert.deepEqual(s.starts,[]);assert.deepEqual(s.writes,[]);});
test('cancellation after committed exhaustion prevents reselection',async()=>{const f=fixture('cancel-after-commit');await f.run();const s=f.state();assert.equal(s.commits,1);assert.deepEqual(s.selected,['a']);assert.deepEqual(s.starts,[]);assert.deepEqual(s.writes,[]);});
