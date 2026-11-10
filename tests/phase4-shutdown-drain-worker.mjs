// Real server process for the Phase 4 shutdown-drain acceptance test (ADR 0016 item 2).
import express from 'express';
const [file, providerPort, mode] = process.argv.slice(2);
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_LEVEL:'error', LOG_PRETTY:'false', PORT:'1', HOST:'127.0.0.1'});
await (await import('./helpers/fresh-db.mjs')).provisionFromEnv(); // what db:init does (ADR 0018)
const nativeFetch = globalThis.fetch;
globalThis.fetch = (_url, options) => nativeFetch(`http://127.0.0.1:${providerPort}/inference`, options);
const {getDb} = await import('../src/db/client.ts');
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {UserRepository} = await import('../src/db/repositories/users.ts');
const {hashApiKey} = await import('../src/utils/encryption.ts');
getDb();
if (mode === 'slow-post-response') {
  // Simulate slow post-response DB work (e.g. writer contention): success accounting and the usage
  // log run after the response is sent and must still be drained before exit.
  const {accountPool} = await import('../src/account-pool/manager.ts');
  const record = accountPool.recordSuccessAsync.bind(accountPool);
  accountPool.recordSuccessAsync = async (...args) => { await new Promise(r => setTimeout(r, 1500).unref()); /* unref: only the registered request drain (deadline kept ref'd) may keep the process alive for this work */ console.log('POST_RESPONSE_DONE'); /* stdout: IPC is disconnected once shutdown starts */ return record(...args); };
}
new AccountRepository().create({name:'a', provider:'openai', credentialType:'api_key', credentials:'sk-fixture-a', priority:0});
new UserRepository().create({apiKeyHash:hashApiKey('fixture-key'), name:'fixture', email:'fixture@example.invalid', tier:'pro', dailyLimit:100});
const original = express.application.listen; let server, ready; const startup = new Promise(r => ready = r);
express.application.listen = function (_port, _host, callback) { server = original.call(this, 0, '127.0.0.1', () => { callback?.(); ready(); }); return server; };
try { await import('../src/server.ts'); } finally { express.application.listen = original; }
await startup;
process.on('message', m => { if (m === 'shutdown') { process.emit('SIGTERM'); process.disconnect(); } });
process.send({event:'ready', port:server.address().port});
