import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SiwcStore } from '../src/upstream/siwc-store.ts';

const key = randomBytes(32);
const vault = {
  encrypt(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64'); },
  decrypt(value) { const b = Buffer.from(value, 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0,12)); d.setAuthTag(b.subarray(12,28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(); },
};
const credential = { issuer:'https://auth.openai.com', subject:'subject-a', clientId:'client-a', accessToken:'access-secret', refreshToken:'refresh-secret', idToken:'id-secret', tokenType:'Bearer', expiresIn:3600, scopes:['offline_access','chatgpt.tokens.use.direct'], savedAt:'2026-01-01T00:00:00.000Z' };
function setup() { const db = new Database(':memory:'); return { db, store: new SiwcStore(db, vault) }; }
test('legacy credential schema migrates without losing credentials', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE siwc_credentials (id TEXT PRIMARY KEY, registration_key TEXT UNIQUE NOT NULL, credentials TEXT NOT NULL)');
  db.prepare('INSERT INTO siwc_credentials VALUES (?, ?, ?)').run('a','legacy',vault.encrypt(JSON.stringify(credential)));
  const store = new SiwcStore(db,vault);
  const snapshot = store.readSnapshot('a');
  assert.deepEqual(snapshot.credential,credential);
  store.replace('a',credential);
  assert.throws(() => store.claimRefresh('a',snapshot),/changed/);
  db.close();
});

test('identical reauthorization invalidates a previously read refresh revision', () => {
  const {db,store} = setup();
  store.create('a',credential);
  const snapshot = store.readSnapshot('a');
  store.replace('a',credential);
  assert.throws(() => store.claimRefresh('a',snapshot),/changed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_refresh_intents').get().n,0);
  db.close();
});

test('stores tokens encrypted and binds replacement to exact identity', () => {
  const {db, store} = setup();
  store.create('a', credential);
  assert.deepEqual(store.read('a'), credential);
  const raw = JSON.stringify(db.prepare('SELECT * FROM siwc_credentials').all());
  for (const secret of [credential.accessToken, credential.refreshToken, credential.idToken]) assert.equal(raw.includes(secret), false);
  assert.throws(() => store.replace('a', {...credential, subject:'subject-b'}), /identity/i);
  assert.deepEqual(store.read('a'), credential);
  db.close();
});
test('reauthorization cannot reinstate a previously reserved refresh token', () => {
  const {db, store} = setup();
  store.create('a', credential);
  store.claimRefresh('a',store.readSnapshot('a'));
  assert.throws(() => store.replace('a', {...credential, accessToken:'new-signin'}), /refresh/i);
  db.close();
});

test('commits an entire rotated credential set and permanently reserves the old token', () => {
  const {db, store} = setup();
  store.create('a', credential);
  const intent = store.claimRefresh('a',store.readSnapshot('a'));
  const next = {...credential, accessToken:'next-access', refreshToken:'next-refresh', scopes:['chatgpt.tokens.use.direct'], expiresIn:1800};
  store.finishRefresh('a', intent, next);
  assert.deepEqual(store.read('a'), next);
  assert.throws(() => store.replace('a', credential), /refresh/i);
  assert.doesNotThrow(() => store.claimRefresh('a',store.readSnapshot('a')));
  db.close();
});

test('refresh reservation is single-use and stale completion cannot overwrite reauthorization', () => {
  const {db, store} = setup();
  store.create('a', credential);
  const intent = store.claimRefresh('a',store.readSnapshot('a'));
  assert.throws(() => store.claimRefresh('a',store.readSnapshot('a')), /refresh/i);
  store.replace('a', {...credential, accessToken:'new-signin', refreshToken:'new-signin-refresh'});
  assert.throws(() => store.finishRefresh('a', intent, {...credential, accessToken:'rotated', refreshToken:'rotated-refresh'}), /changed/i);
  assert.equal(store.read('a').accessToken, 'new-signin');
  db.close();
});
