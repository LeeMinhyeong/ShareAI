import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';

// All configuration and database state are synthetic and isolated.
process.chdir(mkdtempSync(path.join(process.env.TMPDIR, 'account-quota-red-')));
Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {AccountRepository} = await import('../src/db/repositories/accounts.ts');
const {forwardChat} = await import('../src/upstream/forward-chat.ts');
const repo = new AccountRepository();
repo.create({name:'quota-one', provider:'openai', credentialType:'api_key', credentials:'sk-fixture', dailyQuota:1});

async function send() {
  const res = new EventEmitter();
  Object.assign(res, {statusCode:200, headersSent:false, writableEnded:false,
    status(n){this.statusCode=n; return this}, json(value){this.value=value; this.writableEnded=true; return this},
    getHeader(){}, setHeader(){}, end(){this.writableEnded=true}, destroy(){}});
  await forwardChat({user:{id:'fixture-user'},body:{model:'gpt-5',messages:[{role:'user',content:'hello'}]}}, res);
  return res;
}

test('a failed outbound attempt consumes the only daily account slot', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', {status:500}); };
  try {
    assert.equal((await send()).statusCode, 500);
    await send();
    assert.equal(calls, 1, 'a failed dispatch must still exhaust the hard cap');
  } finally { globalThis.fetch = original; }
});
