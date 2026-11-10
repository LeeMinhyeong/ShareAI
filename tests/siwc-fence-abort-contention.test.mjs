import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const scratch=join(homedir(),'AppData','Local','hermes','cache','scratch'); mkdirSync(scratch,{recursive:true});
const dir=mkdtempSync(join(scratch,'siwc-fence-abort-')), file=join(dir,'db.sqlite');
process.env.DATABASE_URL=`sqlite:${file}`; process.env.ENCRYPTION_KEY='0'.repeat(64); process.env.ADMIN_API_KEY='x'.repeat(20);
const {getDb,closeDatabase}=await import('../src/db/client.ts');
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {forwardChat}=await import('../src/upstream/forward-chat.ts');
const {logger}=await import('../src/utils/logger.ts');
// The production client never creates a database; provision this test-owned fresh file.
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv();
const db=getDb();
db.exec("CREATE TABLE siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO siwc_accounts VALUES ('a','a'); INSERT INTO users (id,api_key_hash,name,email,tier) VALUES ('u','h','u','u@example.invalid','free'); INSERT INTO siwc_access_policy VALUES ('a',1,'all')");
new SiwcStore(db,new CredentialVault()).create('a',{issuer:'https://auth.openai.com',subject:'s',clientId:'c',accessToken:'synthetic',idToken:'id',tokenType:'Bearer',expiresIn:3600,scopes:['chatgpt.tokens.use.direct'],savedAt:new Date().toISOString()});
test('cancel during invocation lock wait prevents fetch and records no usage', async () => {
 const child=fork(new URL('./siwc-refresh-lock-worker.mjs',import.meta.url),[file],{stdio:['ignore','ignore','inherit','ipc']});
 const old=globalThis.fetch; let calls=0; globalThis.fetch=async()=>{calls++; throw new Error('unexpected fetch')};
 const req={user:{id:'u'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}};
 const res=Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,status(){return this},json(){return this},getHeader(){},destroy(){}});
 try {
  await once(child,'message');
  const pending=forwardChat(req,res);
  await new Promise(r=>setTimeout(r,80)); res.emit('close');
  await pending;
  assert.equal(calls,0);
  const log=db.prepare('SELECT aborted,success FROM siwc_usage_logs WHERE account_id=?').get('a');
  // Usage reflects physical dispatch (siwc-usage-cancel-http): nothing was sent, so no usage row exists.
  assert.equal(log,undefined);
 } finally {globalThis.fetch=old; if(child.exitCode===null&&child.signalCode===null){child.kill(); await once(child,'exit');}}
});
test('SIWC usage insert failure is reported', async () => {
 const oldFetch=globalThis.fetch, oldError=logger.error; const reports=[];
 logger.error=(...args)=>{reports.push(args)};
 globalThis.fetch=async()=>new Response('data: {"type":"response.completed","response":{}}\n\n',{headers:{'content-type':'text/event-stream'}});
 db.exec("CREATE TRIGGER fail_siwc_log BEFORE INSERT ON siwc_usage_logs BEGIN SELECT RAISE(ABORT, 'synthetic log failure'); END");
 const req={user:{id:'u'},body:{model:'gpt-5',messages:[{role:'user',content:'hi'}],router_options:{siwc_account_id:'a'}}};
 const res=Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,status(){return this},json(){this.writableEnded=true;return this},getHeader(){},destroy(){}});
 try {
  await forwardChat(req,res);
  assert.ok(reports.some(args=>args[1]==='Failed to log SIWC usage'));
 } finally {db.exec('DROP TRIGGER fail_siwc_log'); logger.error=oldError; globalThis.fetch=oldFetch;}
});
after(()=>{closeDatabase();rmSync(dir,{recursive:true,force:true});});
