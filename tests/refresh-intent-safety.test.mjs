import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const scratch = path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, 'refresh-intent-'));
Object.assign(process.env, { NODE_ENV:'test', DATABASE_URL:`sqlite:${path.join(dir,'test.db')}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(20), LOG_PRETTY:'false' });
const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { closeDatabase } = await import('../src/db/client.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const repo = new AccountRepository();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn) { for (let i=0;i<200;i++) { if (fn()) return; await delay(25); } throw new Error('child timeout'); }
function child(id) { const p = fork(new URL('./refresh-race-child.mjs', import.meta.url), [], {env:{...process.env, TEST_ACCOUNT_ID:id}, execArgv:['--import','tsx'], stdio:['ignore','ignore','inherit','ipc']}); const messages=[]; p.on('message', m=>messages.push(m)); return {p,messages}; }
const creds = token => JSON.stringify({kind:'oauth',accessToken:'old',refreshToken:token,expiresAt:1});
test('concurrent processes make at most one provider call', {timeout:10000}, async () => {
  const a=repo.create({name:'intent-race',provider:'openai',credentialType:'oauth',credentials:creds('race-token')});
  const cs=[child(a.id),child(a.id)];
  try { await waitFor(()=>cs.some(c=>c.messages.includes('fetch'))); await waitFor(()=>cs.some(c=>c.messages.includes('failure'))); assert.equal(cs.filter(c=>c.messages.includes('fetch')).length,1); const owner=cs.find(c=>c.messages.includes('fetch')); owner.p.send('success'); await waitFor(()=>owner.messages.includes('success')); assert.equal(JSON.parse(repo.findById(a.id).credentials).refreshToken,'next'); }
  finally { for (const c of cs) if(c.p.connected) c.p.kill(); }
});
test('uncertain network result and same-token credential replacement cannot replay', async () => {
  const a=repo.create({name:'uncertain',provider:'openai',credentialType:'oauth',credentials:creds('uncertain-token')}); let calls=0; const original=globalThis.fetch;
  globalThis.fetch=async()=>{calls++; throw new Error('connection lost');};
  try { await assert.rejects(resolveAuth(a)); repo.update(a.id,{credentials:JSON.stringify({kind:'oauth',accessToken:'replacement',refreshToken:'uncertain-token',expiresAt:1}),status:'active'}); await assert.rejects(resolveAuth(repo.findById(a.id))); assert.equal(calls,1); }
  finally {globalThis.fetch=original;}
});
test('uncertain forced refresh blocks a still-valid access token until reauthentication', async () => {
  const credentials=JSON.stringify({kind:'oauth',accessToken:'valid-old',refreshToken:'forced-token',expiresAt:Date.now() + 60 * 60 * 1000});
  assert.ok(JSON.parse(credentials).expiresAt - Date.now() > 5 * 60 * 1000);
  const a=repo.create({name:'forced',provider:'openai',credentialType:'oauth',credentials}); const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('network lost');};
  try { await assert.rejects(resolveAuth(a,{forceRefresh:true})); repo.update(a.id,{status:'active'}); await assert.rejects(resolveAuth(repo.findById(a.id))); }
  finally {globalThis.fetch=original;}
});
test('identical credential replacement cannot be overwritten by an in-flight refresh', async () => {
  const credentials=creds('aba-token');
  const a=repo.create({name:'aba',provider:'openai',credentialType:'oauth',credentials});
  let started, release; const entered=new Promise(r=>started=r); const gate=new Promise(r=>release=r); const original=globalThis.fetch;
  globalThis.fetch=async()=>{started(); await gate; return new Response(JSON.stringify({access_token:'rotated',refresh_token:'rotated-aba',expires_in:3600}));};
  try { const p=resolveAuth(a); await entered; repo.update(a.id,{credentials}); release(); await assert.rejects(p); assert.equal(repo.findById(a.id).credentials,credentials); }
  finally {globalThis.fetch=original;}
});
process.on('exit',()=>{closeDatabase(); rmSync(dir,{recursive:true,force:true});});
