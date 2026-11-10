import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
process.env.ENCRYPTION_KEY='a'.repeat(64); process.env.ADMIN_API_KEY='x'.repeat(20); process.env.DATABASE_URL??='sqlite:synthetic-reusable-gate.db'; // never opened: the test uses its own in-memory handle
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const forward=await import('../src/upstream/forward-chat.ts');
test('production SIWC gate checks ACL and credential revision under the supplied writer',()=>{
 assert.equal(typeof forward.assertSiwcDispatchGate,'function');
 const db=new Database(':memory:');
 try {
 db.exec("CREATE TABLE siwc_accounts(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE siwc_access_policy(account_id TEXT,enabled INTEGER,scope TEXT); CREATE TABLE siwc_access_users(account_id TEXT,user_id TEXT); CREATE TABLE users(id TEXT,enabled INTEGER); INSERT INTO users VALUES('u',1); INSERT INTO siwc_accounts VALUES('a','a'); INSERT INTO siwc_access_policy VALUES('a',1,'all');");
 const store=new SiwcStore(db,new CredentialVault());
 store.create('a',{issuer:'https://auth.openai.com',subject:'s',clientId:'client',accessToken:'synthetic',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
 const expected=store.readSnapshot('a'); const signal=new AbortController().signal;
 db.transaction(()=>forward.assertSiwcDispatchGate(db,'u','a',expected,signal)).immediate();
 db.exec("UPDATE siwc_access_policy SET enabled=0");
 assert.throws(()=>db.transaction(()=>forward.assertSiwcDispatchGate(db,'u','a',expected,signal)).immediate(),e=>e.status===404);
 db.exec("UPDATE siwc_access_policy SET enabled=1");
 const cancelled=new AbortController();cancelled.abort();
 assert.throws(()=>db.transaction(()=>forward.assertSiwcDispatchGate(db,'u','a',expected,cancelled.signal)).immediate(),e=>e.name==='AbortError');
 store.logout('a');
 assert.throws(()=>db.transaction(()=>forward.assertSiwcDispatchGate(db,'u','a',expected,signal)).immediate());
 } finally {db.close();}
});
