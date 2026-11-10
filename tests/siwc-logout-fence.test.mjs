import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';

const vault = { encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v, 'base64').toString() };
const credential = { issuer:'https://auth.openai.com', subject:'synthetic', clientId:'issued', accessToken:'access', refreshToken:'refresh', idToken:'id', tokenType:'Bearer', expiresIn:3600, scopes:['offline_access'], savedAt:'2026-01-01T00:00:00.000Z' };

const next = { ...credential, accessToken:'new-access', refreshToken:'new-refresh' };

// Mirrors the revision guard and transaction used by siwc-login's returning flow.
function completeReauth(db, store, id, selected, value) {
  db.transaction(() => {
    const current = store.readRegistrationSnapshot(id);
    if (!current || current.revision !== selected.revision || (current.credential?.refreshToken && !value.refreshToken)) throw new Error('Credentials changed or renewable session missing');
    store.replace(id, value);
  }).immediate();
}

test('logout fences refresh and old reauth while retaining identity for fresh reauth', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE siwc_access_policy (account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL); INSERT INTO siwc_access_policy VALUES ('a',1),('b',1)");
    const store = new SiwcStore(db, vault);
    store.create('a', credential);
    store.create('b', {...credential, clientId:'other', refreshToken:'other-refresh'});
    const before = store.readSnapshot('a');
    const selected = store.readRegistrationSnapshot('a');
    const intent = store.claimRefresh('a', before);
    const result = store.logout('a');
    assert.equal(result.remoteUncertain, true); assert.deepEqual(result.credential, credential);
    const after = store.readRegistrationSnapshot('a');
    assert.notEqual(after.revision, selected.revision);
    assert.deepEqual(after.identity, {issuer: credential.issuer, subject: credential.subject, clientId: credential.clientId});
    assert.equal(after.credential, undefined);
    assert.equal(store.read('a'), null);
    assert.equal(db.prepare('SELECT enabled FROM siwc_access_policy WHERE account_id=?').get('a').enabled, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_refresh_intents WHERE account_id=?').get('a').n, 1);
    assert.throws(() => store.finishRefresh('a', intent, next), /credentials changed during refresh/);
    assert.throws(() => store.claimRefresh('a', before), /refresh unavailable/);
    assert.throws(() => completeReauth(db, store, 'a', selected, next), /Credentials changed/);
    assert.equal(store.read('a'), null);
    assert.equal(store.read('b').refreshToken, 'other-refresh');
    assert.equal(db.prepare('SELECT enabled FROM siwc_access_policy WHERE account_id=?').get('b').enabled, 1);
    completeReauth(db, store, 'a', after, next);
    assert.deepEqual(store.read('a'), next);
    assert.notEqual(store.readSnapshot('a').revision, after.revision);
  } finally { db.close(); }
});

test('logout rolls back credential revision when credential update fails', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE siwc_access_policy (account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL); INSERT INTO siwc_access_policy VALUES ('a',1);");
    const store = new SiwcStore(db, vault);
    store.create('a', credential);
    db.exec("CREATE TRIGGER fail_disable BEFORE UPDATE ON siwc_credentials BEGIN SELECT RAISE(ABORT, 'policy failure'); END;");
    const before = store.readSnapshot('a');
    assert.throws(() => store.logout('a'), /policy failure/);
    assert.deepEqual(store.readSnapshot('a'), before);
    assert.equal(db.prepare('SELECT enabled FROM siwc_access_policy WHERE account_id=?').get('a').enabled, 1);
    db.exec('DROP TRIGGER fail_disable');
    const result = store.logout('a'); assert.equal(result.remoteUncertain, false); assert.deepEqual(result.credential, credential);
    assert.notEqual(store.readRegistrationSnapshot('a').revision, before.revision);
  } finally { db.close(); }
});

test('logout works without a policy table and ignores old refresh intents for other credentials', () => {
  const db = new Database(':memory:');
  try {
    const store = new SiwcStore(db, vault);
    store.create('a', credential);
    const intent = store.claimRefresh('a', store.readSnapshot('a'));
    store.finishRefresh('a', intent, next);
    const result = store.logout('a'); assert.equal(result.remoteUncertain, false); assert.deepEqual(result.credential, next);
    assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_refresh_intents').get().n, 1);
  } finally { db.close(); }
});

test('logout accounts for unresolved refresh intent from a replaced credential', () => {
  const db = new Database(':memory:');
  try {
    const store = new SiwcStore(db, vault);
    store.create('a', credential);
    store.claimRefresh('a', store.readSnapshot('a'));
    store.replace('a', next);
    assert.equal(store.logout('a').remoteUncertain, true);
  } finally { db.close(); }
});
