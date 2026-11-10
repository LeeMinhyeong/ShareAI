import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';
const vault = {encrypt: v => v, decrypt: v => v};
const credential = {issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'old',refreshToken:'old-refresh',idToken:'id',tokenType:'Bearer',expiresIn:1,scopes:['offline_access'],savedAt:'2020-01-01T00:00:00.000Z'};

test('zero and invalid timeout cannot claim or disturb an active flight', async () => {
  const db = new Database(':memory:'); const store = new SiwcStore(db,vault); store.create('a',credential);
  const snapshot = store.readSnapshot('a'); let calls = 0;
  const fetcher = async () => { calls++; return Response.json({access_token:'new',refresh_token:'rotated',token_type:'Bearer',expires_in:3600}); };
  for (const timeout of [0,-1,NaN,Infinity]) await assert.rejects(refreshSiwc(store,'a',snapshot,fetcher,timeout));
  const aborted = new AbortController(); aborted.abort(new Error('cancelled'));
  await assert.rejects(refreshSiwc(store,'a',snapshot,fetcher,1000,aborted.signal), /cancelled/);
  assert.equal(calls,0); assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents').get().n,0);
  let release, started; const gate = new Promise(r => release=r), begun = new Promise(r => started=r);
  const valid = refreshSiwc(store,'a',snapshot,async () => { calls++; started(); await gate; return Response.json({access_token:'new',refresh_token:'rotated',token_type:'Bearer',expires_in:3600}); });
  await begun;
  await assert.rejects(refreshSiwc(store,'a',snapshot,fetcher,0));
  assert.equal(calls,1); assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_intents').get().n,1);
  release(); assert.equal((await valid).refreshToken,'rotated'); assert.equal(calls,1); db.close();
});
