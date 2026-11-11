import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Pure helper (no imports); the real module is used rather than a stub.
const ordinaryDeadline = await import('../src/upstream/ordinary-429-deadline.ts');

// Load the real forwarder with strictly in-memory collaborators; no app config,
// database, listener or provider is initialized.
function setup() {
  const selections = [];
  class UpstreamError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const dependencies = {
    crypto: {randomUUID: () => 'synthetic'}, events: {once: () => { throw new Error('unexpected drain'); }},
    '../account-pool/manager.js': {accountPool: {selectCandidate: async (_user, _model, _provider, strategy) => { selections.push(strategy); return null; }}},
    '../db/repositories/usage-logs.js': {UsageLogRepository: class {}},
    '../db/repositories/accounts.js': {RefreshIntentError: class extends Error {}},
    '../utils/logger.js': {logger: {error() {}}}, './tokens.js': {},
    './inference.js': {UpstreamError}, './account-quota.js': {AccountQuotaUnavailable: class extends Error {}},
    '../db/client.js': {getDb: () => ({prepare: () => ({get: () => undefined})})}, '../db/async-writer.js': {}, '../utils/encryption.js': {}, '../db/account-429-v2-store.js': {assert429V2Schema() {}},
    './siwc-store.js': {}, './siwc-refresh.js': {}, './ordinary-429-deadline.js': ordinaryDeadline, './passthrough.js': {parsePassthrough(){throw new Error('passthrough unused');},startPassthrough(){throw new Error('passthrough unused');},PassthroughHttpError:class extends Error{},PassthroughStreamFailure:class extends Error{},routerErrorBody:()=>({}),routerErrorFrame:()=>''},
    '../db/repositories/settings.js': {SettingsRepository: class {getStrategy() {return 'priority';}}, STRATEGIES:['priority','least_used','round_robin']},
  };
  const source = readFileSync(new URL('../src/upstream/forward-chat.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, require: name => {if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`); return dependencies[name];}, AbortController, process, Date, Number, Math, Set, Object, JSON, Error, Promise});
  return {forward:exports.forwardChat, selections:() => selections};
}

const secret = 'synthetic-secret-marker';
async function request(options, model = 'gpt-test') {
  const app = setup();
  const req = {user:{id:'synthetic'}, body:{model, messages:[], router_options:options}};
  const res = {writableEnded:false, destroyed:false, headersSent:false, on() {}, status(n) {this.code=n; return this;}, json(value) {this.body=value; return this;}};
  await app.forward(req, res);
  assert.equal(JSON.stringify(res.body).includes(secret), false, 'response must not echo input secret');
  return {code:res.code, selections:app.selections()};
}

test('unrecognized routing intent is rejected before candidate selection', async () => {
  for (const options of [{siwc_account:secret}, {siwc_account_id:secret, extra:true}, {prefer_accounts:[secret]}, {fallback:true}, {prefer_accounts:[secret], fallback:true}]) {
    assert.deepEqual(await request(options), {code:400, selections:[]});
  }
});

test('non-object routing options are rejected before candidate selection', async () => {
  for (const options of [null, [], 'priority', 1, true]) {
    assert.deepEqual(await request(options), {code:400, selections:[]});
  }
});

test('invalid explicit strategies are rejected before candidate selection', async () => {
  for (const strategy of [null, '', secret, 0, false, [], {}]) {
    assert.deepEqual(await request({strategy}), {code:400, selections:[]});
  }
});

test('each recognized strategy and an omitted strategy reach candidate selection', async () => {
  for (const strategy of ['priority', 'least_used', 'round_robin']) {
    assert.deepEqual(await request({strategy}), {code:503, selections:[strategy]});
  }
  assert.deepEqual(await request({}), {code:503, selections:['priority']});
  assert.deepEqual(await request(undefined), {code:503, selections:['priority']});
});

test('explicit SIWC selection is validated without candidate selection', async () => {
  assert.deepEqual(await request({siwc_account_id:secret}), {code:404, selections:[]});
  for (const id of [null, '', '  ', 42, false, [], {}]) {
    assert.deepEqual(await request({siwc_account_id:id}), {code:400, selections:[]});
  }
  assert.deepEqual(await request({siwc_account_id:secret}, 'claude-test'), {code:400, selections:[]});
  for (const strategy of ['priority', null, secret]) {
    assert.deepEqual(await request({siwc_account_id:secret, strategy}), {code:400, selections:[]});
  }
});
