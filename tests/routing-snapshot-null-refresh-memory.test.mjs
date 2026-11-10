import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the production snapshot with in-memory collaborators, without loading DB or configuration.
test('snapshot accepts a null refresh token only when the access token is usable', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const accounts = [
    { id: 'future', refreshToken: null, expiresAt: now + 3600000 },
    { id: 'past', refreshToken: null, expiresAt: now - 60000 },
    { id: 'malformed', refreshToken: false, expiresAt: now + 3600000 },
  ].map(a => ({ id: a.id, provider: 'openai', status: 'active', credentialType: 'oauth', dailyQuota: 0, stateRevision: 1, credentials: JSON.stringify({kind:'oauth', accessToken:'synthetic', accountId:'workspace', refreshToken:a.refreshToken, expiresAt:a.expiresAt}) }));
  const db = { transaction: fn => fn, prepare(sql) {
    if (sql.includes('account_429_v2_restrictions')) return {all: () => []};
    if (sql.includes('sqlite_master') || sql.includes('ordinary_account_attempts') || sql.includes('account_daily_reservations')) return {get: () => undefined};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  class AccountRepository { findAllAdmin() { return accounts; } findActiveByProvider() { return accounts; } hasRefreshIntent() { throw new Error('Unexpected refresh lookup'); } }
  const dependencies = {
    '../db/client.js': {getDb: () => db},
    '../db/account-429-v2-store.js': {assert429V2Schema: () => {}},
    '../db/repositories/accounts.js': {AccountRepository},
    '../account-pool/manager.js': {accountPool: {observedCooldown: () => 0}},
    '../utils/encryption.js': {CredentialVault: class {}},
    '../upstream/siwc-store.js': {SiwcStore: class {}},
    '../upstream/oauth.js': {parseStoredCredentials: JSON.parse, decodeJwt: () => null},
  };
  const source = readFileSync(new URL('../src/routes/routing-snapshot.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(compiled, {exports, require: name => { if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`); return dependencies[name]; }, Date:Clock, Number, Math, JSON, Set});
  const result = exports.routingSnapshot();
  const state = id => result.accounts.find(row => row.id === id)?.state;
  assert.equal(state('future'), 'no_known_block');
  assert.equal(state('past'), 'unavailable');
  assert.equal(state('malformed'), 'unavailable');
});
