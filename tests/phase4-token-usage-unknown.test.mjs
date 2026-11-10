import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isAbsolute} from 'node:path';

// The npm runner loads tsx before this file: its host-process isolation is not
// established here. The actual fixture runs in a separate empty-env Node child.
const marker = 'FIXTURE_CREDENTIAL_MARKER_4ad871';
let stage = 'START';
function markerTracker() {
  let tail = '', hit = false;
  return {
    push(text) { const combined = tail + text; hit ||= combined.includes(marker); tail = combined.slice(-marker.length + 1); },
    found() { return hit; },
  };
}
if (process.argv[2] !== '--isolated-usage-child') {
  test('usage fixture runs in an isolated, bounded child', async () => {
    const cwd = process.env.TMPDIR;
    assert.equal(typeof cwd === 'string' && isAbsolute(cwd), true, 'absolute TMPDIR required');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-usage-child'], {
      cwd, env: {}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderrCode = '', bytes = 0, stderrBytes = 0;
    const outMarker = markerTracker(), errMarker = markerTracker();
    let tooMuch = false, failed = false, timedOut = false, closed = false;
    const scan = (chunk, which) => {
      const text = chunk.toString('latin1');
      (which === 'out' ? outMarker : errMarker).push(text);
      if (which === 'out') { bytes += chunk.length; if (bytes > 256) { tooMuch = true; child.kill(); } else stdout += text; }
      else { stderrBytes += chunk.length; if (stderrBytes > 256) { tooMuch = true; child.kill(); } stderrCode = (stderrCode + text).slice(0, 128); failed = true; }
    };
    child.stdout.on('data', c => scan(c, 'out'));
    child.stderr.on('data', c => scan(c, 'err'));
    child.on('error', () => { failed = true; });
    child.stdout.on('error', () => { failed = true; });
    child.stderr.on('error', () => { failed = true; });
    const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    const result = await new Promise(resolve => {
      const reapDeadline = setTimeout(() => resolve(null), 25000);
      child.once('close', (code, signal) => { closed = true; clearTimeout(reapDeadline); resolve({code, signal}); });
    });
    clearTimeout(deadline);
    if (!closed) {
      try { child.kill(); } catch { /* close remains unconfirmed */ }
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
    assert.equal(closed, true, 'child close not confirmed');
    assert.equal(timedOut, false, 'child timed out');
    assert.equal(tooMuch, false, 'child output exceeded bound');
    assert.equal(outMarker.found() || errMarker.found(), false, 'synthetic marker appeared in child output');
    const control = markerTracker(); control.push(marker.slice(0, 9)); control.push(marker.slice(9));
    assert.equal(control.found(), true, 'split-marker scanner control failed');
    const category = ['START','GUARDS','ENV','PATCH','CHECK','IMPORTS','SETUP','TEST1','TEST2','TEST3','TEST4','TEST5','ONEA','ONEB','ONEC','ONED','ONEE','ONEF','RUN1','RUN2','RUN3'].find(x => stderrCode === `FIXTURE_${x}\n`) ?? 'OTHER';
    assert.equal(failed, false, `child failed: ${category}`);
    assert.equal(result?.code, 0, 'fixture child failed');
    assert.equal(result?.signal, null, 'fixture child terminated by signal');
    assert.equal(stdout === 'PASS_5\n', true, 'unexpected fixture child output');
  });
} else {
  try {
    const completed = await isolatedChild();
    assert.equal(completed, 5, 'incomplete fixture');
    await new Promise((resolve, reject) => process.stdout.write('PASS_5\n', error => error ? reject(error) : resolve()));
  } catch {
    // Never disclose exceptions, output, or fixture values.
    process.stderr.write(`FIXTURE_${stage}\n`);
    process.exitCode = 1;
  }
}

async function isolatedChild() {
  stage = 'GUARDS';
  stage = 'ENV';
  // Windows may inject SystemRoot despite spawn's empty environment block.
  // Seed the CSPRNG first: Windows OpenSSL cannot reach its entropy source once
// SystemRoot is removed, and the router draws request IDs from randomUUID.
await import('node:crypto').then(c => { c.randomBytes(32); c.randomUUID(); });
for (const key of Object.keys(process.env)) delete process.env[key];
  assert.deepEqual(Object.keys(process.env), []);
  stage = 'PATCH';
  const [{default: http}, {default: https}, {default: net}, {default: dns}, moduleApi] = await Promise.all([
    import('node:http'), import('node:https'), import('node:net'), import('node:dns'), import('node:module'),
  ]);
  const denied = () => { throw new Error('GUARD_DENIED'); };
  for (const target of [http, https]) { target.request = denied; target.get = denied; target.Server.prototype.listen = denied; }
  net.connect = denied; net.createConnection = denied; net.Server.prototype.listen = denied; net.Socket.prototype.connect = denied;
  for (const key of Object.keys(dns)) if (typeof dns[key] === 'function' && /^(lookup|resolve|reverse)/.test(key)) dns[key] = denied;
  for (const key of Object.keys(dns.promises)) if (typeof dns.promises[key] === 'function' && /^(lookup|resolve|reverse)/.test(key)) dns.promises[key] = denied;
  globalThis.fetch = denied;
  moduleApi.syncBuiltinESMExports();
  stage = 'CHECK';
  assert.throws(() => http.get('http://example.invalid'), /GUARD_DENIED/);
  assert.throws(() => https.request('https://example.invalid'), /GUARD_DENIED/);
  assert.throws(() => net.connect(1), /GUARD_DENIED/);
  assert.throws(() => dns.lookup('example.invalid', () => {}), /GUARD_DENIED/);
  assert.throws(() => new net.Server().listen(0), /GUARD_DENIED/);
  assert.throws(() => globalThis.fetch('http://example.invalid'), /GUARD_DENIED/);
  const namedNet = await import('node:net');
  assert.throws(() => namedNet.connect(1), /GUARD_DENIED/);
  stage = 'IMPORTS';
  const {readFileSync} = await import('node:fs');
  const {default: vm} = await import('node:vm');
  const {randomUUID} = await import('node:crypto');
  const {once, EventEmitter} = await import('node:events');
  const {default: ts} = await import('typescript');
  const {default: Database} = await import('better-sqlite3');
  const tests = [];
  const test = (name, fn) => tests.push({name, fn});
stage = 'SETUP';
const db = new Database(':memory:');
try {
const context = vm.createContext({console, Response, TransformStream, Headers, ReadableStream, TextDecoder, AbortController, setTimeout, clearTimeout, Date, Math, JSON, Symbol, Set, Map, WeakSet, WeakMap, Promise, Error, RangeError, Number, String, Object, Array, BigInt, process:{env:Object.freeze({}),hrtime:Object.assign(() => [0, 0], {bigint: () => 0n})}, fetch:async()=>{throw Error('unexpected fetch')}});
const root = new URL('../src/', import.meta.url);
const real = new Map();
function moduleFor(path) {
  if (real.has(path)) return real.get(path);
  const source = readFileSync(new URL(path,root),'utf8');
  const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod = {namespace:{}, evaluate:async()=>{}}; real.set(path,mod);
  const requireStub = spec => requireFixture(spec, path);
  const wrapped = vm.runInContext('(function(exports,require){'+js+'\n})',context,{filename:path});
  wrapped(mod.namespace,requireStub);
  return mod;
}
function requireFixture(spec, path) {
    const resolved = new URL(spec, 'file:///'+path).pathname.slice(1).replace(/\.js$/,'.ts');
    if (['upstream/inference.ts','db/repositories/usage-logs.ts','db/usage-utc.ts','db/schema.ts'].includes(resolved)) return moduleFor(resolved).namespace;
    if (Object.hasOwn(stubs, resolved)) return stubs[resolved];
    if (Object.hasOwn(stubs, spec)) return stubs[spec];
    throw Error('unexpected import');
}
const account={id:'a',credentialType:'api_key',stateRevision:0,credentialRevision:0};
const pool={selectCandidate:async()=>({kind:'upstream',id:'a',account}),recordSuccessAsync:async()=>{},recordFailureAsync:async()=>{}};
const stubs={
  'crypto':{randomUUID},'events':{once},
  'account-pool/manager.ts':{accountPool:pool},'db/client.ts':{getDb:()=>db},
  'db/async-writer.ts':{withAsyncWriter:async fn=>fn(db)},
  'db/repositories/accounts.ts':{RefreshIntentError:class extends Error{}},
  'utils/logger.ts':{logger:{error(){}}},
  'upstream/tokens.ts':{resolveAuth:async()=>({kind:'api_key',token:'sk-FIXTURE_CREDENTIAL_MARKER_4ad871',canRefresh:false,observedAccount:account})},
  'upstream/account-quota.ts':{invokeAccountAttempt:async(_a,_s,start,observe)=>{observe({accountId:'a'});return start()},settleAccountAttempt:async()=>{},AccountAttemptOpen:class extends Error{},AccountQuotaUnavailable:class extends Error{},AccountCooldownBeforeDispatch:class extends Error{}},
  'db/account-429-v2-store.ts':{arm429V2(){},assert429V2Schema(){}},
  'utils/encryption.ts':{CredentialVault:class{}},'upstream/siwc-store.ts':{SiwcStore:class{}},
  'upstream/siwc-refresh.ts':{refreshSiwcSnapshot(){}},
  'db/repositories/settings.ts':{SettingsRepository:class{getStrategy(){return 'priority'}},STRATEGIES:['priority']},
  'upstream/ordinary-429-deadline.ts':{ordinary429Deadline(){return Number.MAX_SAFE_INTEGER},recovery429Duration(){return null}},
};
const schema=await moduleFor('db/schema.ts'); await schema.evaluate(); db.exec(schema.namespace.SQL_SCHEMA);
db.exec("CREATE TABLE siwc_usage_logs(id TEXT,user_id TEXT,account_id TEXT,timestamp TEXT,model TEXT,provider TEXT,input_tokens INTEGER,output_tokens INTEGER,success INTEGER,latency_ms INTEGER); INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','h','n','e','free'); INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES('a','a','openai','api_key','FIXTURE_CREDENTIAL_MARKER_4ad871','active','2024-01-01')");
const forward=await moduleFor('upstream/forward-chat.ts'); await forward.evaluate();
const repoModule=real.get('db/repositories/usage-logs.ts'); const repo=new repoModule.namespace.UsageLogRepository();
class FakeResponse extends EventEmitter { constructor(){super();this.headers={};this.writableEnded=false;this.headersSent=false;this.destroyed=false;} setHeader(k,v){this.headers[k]=v} getHeader(k){return this.headers[k]} json(value){this.body=value;this.writableEnded=true;this.headersSent=true;return this} status(value){this.statusCode=value;return this} write(){this.headersSent=true;return true} end(){this.headersSent=true;this.writableEnded=true} destroy(){this.destroyed=true} }
async function run(usage, stream=false) {
  const chunks=[{choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]}];
  if (usage !== undefined) chunks.push({choices:[],usage});
  const body=chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n';
  context.fetch=async()=>new Response(body,{headers:{'content-type':'text/event-stream'}});
  const res=new FakeResponse();
  stage='RUN1';
  await forward.namespace.forwardChat({user:{id:'u'},body:{model:'gpt-test',messages:[{role:'user',content:'hello'}],stream}},res);
  stage='RUN2';
  if (stream) assert.equal(res.writableEnded,true); else assert.equal(res.body?.object,'chat.completion');
  stage='RUN3';
  return db.prepare('SELECT input_tokens,output_tokens FROM usage_logs ORDER BY rowid DESC LIMIT 1').get();
}
test('ordinary forward stores missing provider usage as null rather than measured zero',async()=>{
  stage='ONEA';
  const empty=repo.getTodayStats('u'); assert.equal(empty.totalRequests,0); assert.equal(empty.totalTokens,0); assert.equal(empty.totalTokensComplete,true);
  stage='ONEB';
  assert.deepEqual(await run({prompt_tokens:0,completion_tokens:0}),{input_tokens:0,output_tokens:0});
  stage='ONEC';
  assert.equal(repo.getTodayStats('u').totalTokensComplete,true);
  assert.equal(repo.getAccountTodayStats('a').totalTokensComplete,true);
  stage='ONED';
  assert.deepEqual(await run(undefined),{input_tokens:null,output_tokens:null});
  stage='ONEE';
  assert.deepEqual(await run({prompt_tokens:3}),{input_tokens:null,output_tokens:null});
  assert.deepEqual(await run({prompt_tokens:-1,completion_tokens:4}),{input_tokens:null,output_tokens:null});
  stage='ONEF';
  const stats=repo.getTodayStats('u'); assert.equal(stats.totalRequests,4); assert.equal(stats.totalTokens,0); assert.equal(stats.totalTokensComplete,false);
});
test('streaming forward preserves measured and missing token usage',async()=>{
  assert.deepEqual(await run({prompt_tokens:3,completion_tokens:2},true),{input_tokens:3,output_tokens:2});
  assert.deepEqual(await run(undefined,true),{input_tokens:null,output_tokens:null});
  const stats=repo.getTodayStats('u'); assert.equal(stats.totalTokens,5); assert.equal(stats.totalTokensComplete,false);
  const logs=repo.findByUser('u'); assert.ok(logs.some(x=>x.inputTokens===null && x.outputTokens===null)); assert.ok(logs.some(x=>x.inputTokens===3 && x.outputTokens===2));
});
test('schema preflight accepts fresh schema and rejects legacy schema before writes',()=>{
  schema.namespace.assertTokenUsageSchema(db);
  const legacy=new Database(':memory:');
  try {
    legacy.exec('CREATE TABLE usage_logs(input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0)');
    const before=legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='usage_logs'").get();
    assert.throws(()=>schema.namespace.assertTokenUsageSchema(legacy),/offline token-usage migration/);
    assert.deepEqual(legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='usage_logs'").get(),before);
  } finally {legacy.close()}
});
test('per-log reads distinguish measured zero, historical zero, unknown and unsafe values',()=>{
  const insert=db.prepare("INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,usage_known,success,latency_ms) VALUES(?, 'u','a',?,'m','openai',?,?,?,1,0)");
  for (const [id,input,output,known] of [['measured',0,0,1],['historical',0,0,null],['unknown',null,null,0],['unsafe',9007199254740993n,0,null]]) insert.run(id,new Date().toISOString(),input,output,known);
  // Model damaged or migrated rows without weakening the production schema.
  db.pragma('ignore_check_constraints = ON');
  try { insert.run('legacy-zero',new Date().toISOString(),0,0,0); insert.run('invalid',new Date().toISOString(),-1,0,1); }
  finally { db.pragma('ignore_check_constraints = OFF'); }
  for (const get of [id=>repo.findById(id),id=>repo.findByUser('u').find(x=>x.id===id),id=>repo.findByAccount('a').find(x=>x.id===id)]) {
    for (const [id,input,output,known] of [['measured',0,0,true],['historical',0,0,false],['legacy-zero',0,0,false],['unknown',null,null,false],['unsafe',null,null,false],['invalid',null,null,false]]) {
      const log=get(id); assert.equal(log.inputTokens,input); assert.equal(log.outputTokens,output); assert.equal(log.usageKnown,known);
    }
  }
});
test('legacy zero remains ambiguous and safe aggregate overflow is incomplete',()=>{
  db.prepare("INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES('legacy','u','a',?,'m','openai',0,0,1,0)").run(new Date().toISOString());
  assert.equal(repo.getAccountTodayStats('a').totalTokensComplete,false);
  for (let i=0;i<2;i++) repo.create({userId:'u',upstreamAccountId:'a',model:'m',provider:'openai',inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:0,success:true,latencyMs:0},db);
  const stats=repo.getTodayStats('u'); assert.equal(stats.totalTokens,Number.MAX_SAFE_INTEGER); assert.equal(stats.totalTokensComplete,false);
});


  // Explicitly test that a forbidden and inherited host import is rejected.
  assert.throws(() => requireFixture('toString', 'upstream/forward-chat.ts'), /unexpected import/);
  assert.throws(() => requireFixture('dotenv/config', 'upstream/forward-chat.ts'), /unexpected import/);
  assert.equal(tests.length, 5, 'expected five registered cases');
  let completed = 0;
  for (let i=0; i<tests.length; i++) { stage = ['TEST1','TEST2','TEST3','TEST4','TEST5'][i]; await tests[i].fn(); completed++; }
  assert.equal(completed, 5, 'expected five completed cases');
  return completed;
} finally { db.close(); }
}
