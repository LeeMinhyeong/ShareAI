import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
process.chdir(mkdtempSync(path.join(process.env.TMPDIR,'weight-isolated-')));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'sqlite::memory:',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase(); // the production client refuses an unprovisioned :memory: database
const {getDb}=await import('../src/db/client.ts');
const {AccountRepository}=await import('../src/db/repositories/accounts.ts');
const {AccountPoolManager}=await import('../src/account-pool/manager.ts');
const db=getDb(), repo=new AccountRepository();
const a=repo.create({name:'huge',provider:'anthropic',credentialType:'api_key',credentials:'synthetic',weight:100000000});
const b=repo.create({name:'malformed',provider:'anthropic',credentialType:'api_key',credentials:'synthetic',weight:1});
db.prepare('UPDATE upstream_accounts SET weight=? WHERE id=?').run('invalid',b.id);
const pool=new AccountPoolManager();
const picked=pool.getCandidates('anthropic','round_robin');
assert.equal(picked.length,2);
const ordered=[a,b].sort((x,y)=>x.id.localeCompare(y.id));
const heavyFirst=ordered[0].id===a.id;
const key=JSON.stringify(['anthropic',ordered.map(x=>x.id)]);
const boundary=heavyFirst ? 100000000n : 1n;
pool.roundRobinCounters.set(key,boundary-1n);
assert.equal(pool.getCandidates('anthropic','round_robin')[0].id,ordered[0].id);
assert.equal(pool.getCandidates('anthropic','round_robin')[0].id,ordered[1].id);
assert.equal(pool.getCandidates('anthropic','round_robin')[0].id,heavyFirst ? ordered[0].id : ordered[1].id);
for(const value of [NaN,Infinity,-1,0,'invalid']) {
 const p=new AccountPoolManager();
 const items=[{id:'a',weight:value},{id:'b',weight:1}];
 assert.deepEqual(p.roundRobinOrder('x',items,x=>x.id).map(x=>x.id),['a','b']);
 assert.deepEqual(p.roundRobinOrder('x',items,x=>x.id).map(x=>x.id),['b','a']);
}
assert.equal(db.prepare('SELECT weight FROM upstream_accounts WHERE id=?').get(a.id).weight,100000000);
assert.equal(db.prepare('SELECT weight FROM upstream_accounts WHERE id=?').get(b.id).weight,'invalid');
