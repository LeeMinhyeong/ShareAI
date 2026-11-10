import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';

const vault = {encrypt:v=>Buffer.from(v).toString('base64'),decrypt:v=>Buffer.from(v,'base64').toString()};
const credential = {issuer:'https://auth.openai.com',subject:'subject',clientId:'client',accessToken:'access',refreshToken:'refresh',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['offline_access'],savedAt:'2026-01-01T00:00:00.000Z'};
for (const kind of ['refresh','authorization']) for (const crash of [false,true]) test(`cross-process ${kind} ${crash ? 'crash' : 'in flight'} fences logout`, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR,'siwc-logout-process-'));
  const file = join(dir,'db.sqlite');
  let db = new Database(file,{timeout:5000});
  let worker;
  try {
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    db.exec("CREATE TABLE siwc_access_policy(account_id TEXT PRIMARY KEY, enabled INTEGER); INSERT INTO siwc_access_policy VALUES ('a',1),('b',1)");
    let store = new SiwcStore(db,vault); store.create('a',credential); store.create('b',{...credential,clientId:'other',refreshToken:'other'});
    worker = fork(new URL('./siwc-logout-race-worker.mjs',import.meta.url),[file,kind],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','ignore','inherit','ipc']});
    assert.equal((await once(worker,'message'))[0],'claimed');
    if (crash) { const exited = once(worker,'exit'); worker.kill(); await exited; }
    db.close(); db = new Database(file,{timeout:5000}); store = new SiwcStore(db,vault);
    if (kind === 'refresh') store.replace('a',{...credential,refreshToken:'fresh'});
    assert.equal(store.logout('a').remoteUncertain,true);
    assert.equal(store.read('a'),null);
    assert.equal(db.prepare('SELECT enabled FROM siwc_access_policy WHERE account_id=?').get('a').enabled,1);
    assert.equal(store.read('b').refreshToken,'other');
    assert.equal(db.prepare('SELECT enabled FROM siwc_access_policy WHERE account_id=?').get('b').enabled,1);
    assert.equal(store.logout('b').remoteUncertain,false);
    if (!crash) { const exited = once(worker,'exit'); worker.send('done'); await exited; }
  } finally { if (worker?.connected) worker.kill(); db.close(); rmSync(dir,{recursive:true,force:true}); }
});
