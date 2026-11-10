import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';

function load(path, deps = {}, extra = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, require: name => { if (!Object.hasOwn(deps,name)) throw new Error('Unexpected import: '+name); return deps[name]; }, ...extra});
  return exports;
}
const v2 = load('../src/db/account-429-v2-store.ts');
const now = Date.parse('2035-01-01T00:00:00Z');
class Clock extends Date { static now() { return now; } }
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ordinary_account_attempts(account_id TEXT); CREATE TABLE siwc_account_attempts(account_id TEXT);
    CREATE TABLE account_daily_reservations(account_id TEXT, day TEXT, used INTEGER, legacy_ambiguous INTEGER);
    CREATE TABLE siwc_accounts(id TEXT); CREATE TABLE siwc_access_policy(account_id TEXT, enabled INTEGER);
    CREATE TABLE account_429_cooldowns(kind TEXT, account_id TEXT, until_at INTEGER);`);
  db.transaction(() => v2.provision429V2(db)).immediate();
  const accounts = ['same','clear','local','open','siwc-only'].map(id => ({id,provider:'test',status:'active',credentialType:'api_key',credentials:'synthetic-secret',dailyQuota:0,stateRevision:1}));
  db.prepare('INSERT INTO siwc_accounts VALUES (?)').run('same');
  db.prepare('INSERT INTO siwc_access_policy VALUES (?,1)').run('same');
  db.prepare('INSERT INTO siwc_accounts VALUES (?)').run('siwc-only');
  db.prepare('INSERT INTO siwc_access_policy VALUES (?,1)').run('siwc-only');
  class AccountRepository { findAllAdmin() { return accounts; } findActiveByProvider() { return accounts; } }
  class SiwcStore { readSnapshot() { return {revision:1,credential:{savedAt:'2035-01-01T00:00:00Z',expiresIn:3600,scopes:['chatgpt.tokens.use.direct']}}; } }
  const deps = {'../db/client.js':{getDb:()=>db}, '../db/repositories/accounts.js':{AccountRepository}, '../account-pool/manager.js':{accountPool:{observedCooldown:id=>id==='local'?now+5000:0,siwcFailureMarker:()=>null}}, '../utils/encryption.js':{CredentialVault:class {}}, '../upstream/siwc-store.js':{SiwcStore}, '../upstream/oauth.js':{}, '../db/account-429-v2-store.js':v2};
  const snapshot = load('../src/routes/routing-snapshot.ts',deps,{Date:Clock}).routingSnapshot;
  return {db,snapshot};
}
function row(result,kind,id) { return result.accounts.find(r=>r.kind===kind && r.id===id); }
test('v2 row presence is authoritative without wall expiry, including kind collisions and OPEN', () => {
  const {db,snapshot} = fixture();
  try {
    db.transaction(() => { v2.arm429V2(db,'upstream','same',1000); v2.arm429V2(db,'upstream','open',1000); v2.arm429V2(db,'siwc','siwc-only',null); }).immediate();
    db.prepare('INSERT INTO ordinary_account_attempts VALUES (?)').run('open');
    db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?)').run('upstream','same',1);
    db.prepare('INSERT INTO account_429_cooldowns VALUES (?,?,?)').run('upstream','clear',now+100000);
    const result = snapshot();
    assert.equal(row(result,'upstream','same').state,'restricted');
    assert.equal(Object.hasOwn(row(result,'upstream','same'),'cooldown_until'),false);
    assert.equal(row(result,'siwc','same').state,'no_known_block');
    assert.equal(row(result,'siwc','siwc-only').state,'restricted');
    assert.equal(row(result,'upstream','siwc-only').state,'no_known_block');
    assert.equal(row(result,'upstream','open').state,'open');
    assert.equal(row(result,'upstream','clear').state,'no_known_block');
    assert.equal(row(result,'upstream','local').state,'cooldown_until');
    assert.equal(row(result,'upstream','local').cooldown_until,now+5000);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
  } finally { db.close(); }
});
test('missing or corrupt v2 schema reports unknown while preserving OPEN precedence', () => {
  for (const mutation of ['DELETE FROM account_429_v2_schema_marker','DROP TABLE account_429_v2_restrictions', 'PRAGMA ignore_check_constraints=ON; UPDATE account_429_v2_counter SET generation=-1']) {
    const {db,snapshot} = fixture();
    try {
      db.prepare('INSERT INTO ordinary_account_attempts VALUES (?)').run('open');
      db.prepare('INSERT INTO siwc_account_attempts VALUES (?)').run('same');
      db.exec(mutation);
      const result = snapshot();
      assert.deepEqual(JSON.parse(JSON.stringify(result.accounts)), [
        {kind:'upstream',id:'same',state:'unknown'},
        {kind:'upstream',id:'clear',state:'unknown'},
        {kind:'upstream',id:'local',state:'unknown'},
        {kind:'upstream',id:'open',state:'open'},
        {kind:'upstream',id:'siwc-only',state:'unknown'},
        {kind:'siwc',id:'same',state:'open'},
        {kind:'siwc',id:'siwc-only',state:'unknown'},
      ]);
    } finally { db.close(); }
  }
});
test('dashboard renders restricted state with unknown timing and advisory context', () => {
  const view = load('../dashboard/src/pages/RoutingSnapshot.tsx',{'react':React,'react/jsx-runtime':jsxRuntime}).RoutingSnapshotView;
  const html = renderToStaticMarkup(React.createElement(view,{snapshot:{as_of:'2035-01-01T00:00:00Z',note:'Not request eligibility',accounts:[{kind:'upstream',id:'synthetic',state:'restricted'}]}}));
  assert.match(html,/제한/);
  assert.match(html,/시점/);
  assert.match(html,/Not request eligibility/);
  assert.doesNotMatch(html,/cooldown until/);
});
