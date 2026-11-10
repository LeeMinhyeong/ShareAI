import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';

const credential = {issuer:'https://auth.openai.com',subject:'test',clientId:'client',accessToken:'access',refreshToken:'refresh',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access'],savedAt:'2026-01-01T00:00:00.000Z'};
const vault = {encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value,'base64').toString()};

test('logout and refresh fencing persist across database close and reopen', () => {
  const dir = mkdtempSync(join(process.env.LOCALAPPDATA,'hermes','cache','scratch','siwc-restart-'));
  const path = join(dir,'test.db'); let db = new Database(path);
  try {
    let store = new SiwcStore(db,vault); store.create('account',credential);
    const old = store.readSnapshot('account'); const intent = store.claimRefresh('account',old);
    assert.equal(store.logout('account').remoteUncertain,true);
    const revision = store.readRegistrationSnapshot('account').revision;
    db.close(); db = new Database(path); store = new SiwcStore(db,vault);
    assert.equal(store.read('account'),null); assert.equal(store.readRegistrationSnapshot('account').revision,revision);
    assert.throws(() => store.finishRefresh('account',intent,{...credential,refreshToken:'rotated'}));
    assert.throws(() => store.claimRefresh('account',old));
    assert.throws(() => store.replace('account',credential));
    store.replace('account',{...credential,refreshToken:'fresh'}); assert.equal(store.read('account').refreshToken,'fresh');
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
