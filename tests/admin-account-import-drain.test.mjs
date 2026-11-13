import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ADMIN = 'synthetic-admin-key-9841';
const CREDENTIAL = 'sk-ant-api-synthetic-import-7246';
const CIPHERTEXT = 'synthetic-ciphertext-6328';
const FAULT = 'synthetic-thrown-fault-5183';
const markers = [ADMIN, CREDENTIAL, CIPHERTEXT, FAULT];

if (process.argv[2] !== '--child') {
  test('account import owns synchronous work through shutdown', async () => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env: {}, stdio: ['ignore','pipe','pipe'] });
    let output = '', tooMuch = false, closed = false, result, childError = false, timedOut = false;
    const terminate = () => { try { child.kill(); } catch { childError = true; } };
    child.on('error', () => { childError = true; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', () => { childError = true; });
      stream.on('data', chunk => { if (output.length + chunk.length > 16000) { tooMuch = true; terminate(); } else output += chunk; });
    }
    const close = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({code, signal}); }));
    const bounded = async (promise, ms) => { let timer; try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); } finally { clearTimeout(timer); } };
    try { result = await bounded(close, 60000); timedOut = !closed; }
    finally {
      if (!closed) { terminate(); result = await bounded(close, 5000); }
      if (!closed) { child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); }
    }
    assert.equal(tooMuch, false, 'child output limit');
    assert.equal(markers.every(marker => !output.includes(marker)), true, 'child output contains synthetic marker');
    assert.equal(closed, true, 'child close unconfirmed');
    assert.equal(timedOut, false, 'child timed out');
    assert.equal(childError, false, 'child process or stream error');

    assert.equal(result.code === 0 && result.signal === null, true, 'isolated import fixture failed');
  });
} else {
  let phase='phase load';
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const { EventEmitter } = await import('node:events');
    const { inspect } = await import('node:util');
    const vm = await import('node:vm');
    const require = createRequire(import.meta.url), ts = require('typescript'), express = require('express');
    const fakeProcess = Object.freeze({env:Object.freeze({})});
    const captures = [];
    const capture = (source, method, args) => captures.push({source, method, text: inspect(args, {depth:null, maxStringLength:null, maxArrayLength:null, breakLength:Infinity, getters:false})});
    const fakeConsole = Object.freeze(Object.fromEntries(['log','info','debug','warn','error'].map(method => [method, (...args) => capture('console', method, args)])));
    const logger = Object.freeze(Object.fromEntries(['info','debug','warn','error'].map(method => [method, (...args) => capture('logger', method, args)])));
    const containsMarker = (text, marker) => text.includes(marker);
    function load(path, deps) {
      phase=({'../src/upstream/oauth.ts':'load oauth','../src/db/repositories/accounts.ts':'load accounts','../src/auth/user-auth.ts':'load auth','../src/routes/admin.ts':'load admin','../src/request-work.ts':'load manager'})[path] || 'phase load';
      const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
      const out = {};

      vm.runInNewContext(`(function(exports,require){${code}\n})`, {process:fakeProcess, console:fakeConsole, AbortController})(out, name => {
        if (!Object.hasOwn(deps, name)) throw Error('unexpected dependency');
        return deps[name];
      });
      return out;
    }
    const ok = (condition, message) => { if (!condition) throw Error(message); };
    // Exercise the same injected sink and checker without contaminating real logs.
    for (const [source, sink, methods] of [['logger',logger,['info','debug','warn','error']],['console',fakeConsole,['log','info','debug','warn','error']]]) {
      for (const method of methods) for (const marker of markers) {
        sink[method](marker);
        const entry = captures.pop();
        ok(entry.source === source && entry.method === method && containsMarker(entry.text, marker), 'capture negative control');
      }
    }
    const {RequestWorkManager} = load('../src/request-work.ts', {'node:async_hooks':require('node:async_hooks')});
    function fixture(stage, failure, signal = [Error(FAULT)], premature = false) {
      phase='phase fixture';
      const manager = new RequestWorkManager(), counts = {parse:0,db:0,encrypt:0,sql:0,json:0,terminal:0};
      let drained, row, observed = false, activeAtTerminal, ownedScope, postStopAdmission;
      const originalOwned = manager.ownedDispatch.bind(manager);
      manager.ownedDispatch = cb => originalOwned(scope => { ownedScope=scope; return cb({...scope,terminal(){ counts.terminal++; activeAtTerminal=manager.active; scope.terminal(); }}); });
      function hit(name) {
        if (stage === name) { drained = manager.stopAndDrain(); if (premature) ownedScope.terminal(); postStopAdmission = manager.ownedDispatch(() => {}); observed = manager.active === 1; }
        if ((Array.isArray(failure) ? failure : [failure]).includes(name)) throw signal[0];
      }
      const oauth = load('../src/upstream/oauth.ts', {'crypto':require('crypto'),'http':require('http'),'../utils/logger.js':{logger}});
      const parsed = oauth.parseImportedCredential;
      oauth.parseImportedCredential = (...args) => { counts.parse++; hit('parse'); return parsed(...args); };
      const db = {prepare(sql) { return {run(...args) { counts.sql++; hit('sql'); row={id:args[0],name:args[1],provider:args[2],credential_type:args[3],credentials:args[4],meta:args[5],status:'active'}; },get() { return row; }}; }};
      class Vault { encrypt(v){counts.encrypt++;hit('encrypt');return CIPHERTEXT;} decrypt(){return CREDENTIAL;} }
      const accounts = load('../src/db/repositories/accounts.ts', {'../client.js':{getDb(){counts.db++;hit('db');return db;}},'crypto':{randomUUID:()=> 'fixture-id',createHash:require('crypto').createHash},'../../upstream/oauth.js':oauth,'../../utils/encryption.js':{CredentialVault:Vault}});
      if (failure === 'field') { const create = accounts.AccountRepository.prototype.create; accounts.AccountRepository.prototype.create = function (...args) { const account = create.apply(this,args); Object.defineProperty(account,'id',{get(){throw Error(FAULT)}}); return account; }; }
      const auth = load('../src/auth/user-auth.ts', {'../db/repositories/users.js':{UserRepository:class {}},'../utils/encryption.js':{},'../utils/logger.js':{logger},'../config/env.js':{env:{ADMIN_API_KEY:ADMIN}},'../db/async-writer.js':{},'../request-work.js':{requestWork:manager}});
      const admin = load('../src/routes/admin.ts', {'express':express,'../auth/user-auth.js':auth,'../request-work.js':{requestWork:manager},'../db/repositories/users.js':{UserRepository:class {}},'../db/repositories/accounts.js':accounts,'../db/repositories/usage-logs.js':{UsageLogRepository:class {}},'../db/repositories/settings.js':{SettingsRepository:class {},STRATEGIES:[]},'../utils/encryption.js':{},'../utils/logger.js':{logger},'../upstream/oauth.js':oauth,'../upstream/siwc-login.js':{createSiwcRouter:()=>express.Router()},'./routing-snapshot.js':{}});
      const app = express(); app.use('/admin',admin.default);
      async function request(authHeader, body) {
        phase='phase request';
        const req=Object.assign(new EventEmitter(),{method:'POST',url:'/admin/accounts/import',headers:authHeader?{authorization:authHeader}:{},body});
        const res=Object.assign(new EventEmitter(),{statusCode:200,writableEnded:false,headersSent:false,statuses:[],fields:{},setHeader(){return this;},getHeader(){return undefined;},set(name,value){this.fields[name.toLowerCase()]=value;return this;},status(n){this.statuses.push(n);hit('status');this.statusCode=n;return this;},json(value){captures.push({source:'response',method:String(this.statusCode),text:JSON.stringify(value)});counts.json++;hit('json');this.body=value;this.headersSent=true;this.writableEnded=true;return this;},destroy(){this.destroyed=true;hit('destroy');}});
        app.handle(req,res,err=>{ res.dispatchFailed = !!err; res.dispatchDone = true; if (err && typeof err.message === 'string') res.dispatchKind = ['setHeader','getHeader','removeHeader','socket','connection','url','headers'].find(x=>err.message.includes(x)); }); await drain(new Promise(resolve=>setImmediate(resolve))); return res;
      }
      return {manager,counts,request,get observed(){return observed},get drained(){return drained},get activeAtTerminal(){return activeAtTerminal},get postStopAdmission(){return postStopAdmission},get row(){return row}};
    }
    async function drain(promise) { let timer; try { await Promise.race([promise, new Promise((_,reject) => { timer=setTimeout(() => reject(Error('drain timeout')),2000); })]); } finally { clearTimeout(timer); } }
    const body={name:'Fixture',provider:'anthropic',credentials:'sk-ant-api-fixture-secret'};
    for (const stage of ['parse','db','encrypt','sql','json']) {
      const f=fixture(stage), res=await f.request(`Bearer ${ADMIN}`,body);
      ok(f.postStopAdmission === false,'post stop admission');
      ok(f.observed,'ownership checkpoint');
      ok(f.counts.terminal===1 && f.activeAtTerminal===1 && f.manager.active===0,'terminal ownership');
      await drain(f.drained);
      ok(res.statusCode===201 && res.fields['cache-control']==='no-store' && JSON.stringify(res.body)===JSON.stringify({account:{id:'fixture-id',name:'Fixture',provider:'anthropic',credentialType:'api_key',status:'active'}}),'success response');
      ok(JSON.stringify(f.counts)===JSON.stringify({parse:1,db:2,encrypt:1,sql:1,json:1,terminal:1}),'success counters');
    }
    for (const stage of ['parse','db','encrypt','sql','json']) { const f=fixture(stage,undefined,undefined,true); await f.request(`Bearer ${ADMIN}`,body); ok(f.postStopAdmission===false,'post stop admission'); let detected=false; try { ok(f.observed,'ownership checkpoint'); } catch (error) { detected=error.message==='ownership checkpoint'; } ok(detected && f.activeAtTerminal===0,'mutation control'); await drain(f.drained); }
    for (const [header,expected] of [[undefined,401],['Bearer invalid',403]]) { const f=fixture(); const r=await f.request(header,body); ok(r.statusCode===expected && f.counts.parse===0,'authentication'); }
    {const f=fixture(); await drain(f.manager.stopAndDrain()); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.statusCode===503 && r.fields['cache-control']===undefined && f.counts.parse===0 && f.counts.db===0 && f.counts.encrypt===0,'post stop rejection');}
    {const f=fixture(undefined,'field'); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.statusCode===500 && r.body?.error?.message==='Failed to process admin account request' && !r.destroyed && f.counts.sql===1 && !!f.row,'account field failure');}
    {const f=fixture(); const r=await f.request(`Bearer ${ADMIN}`,{...body,credentials:'not valid'}); ok(r.statusCode===400 && r.fields['cache-control']==='no-store' && JSON.stringify(r.body)===JSON.stringify({error:{code:'credential_format_unrecognized',message:'Credential format not recognized for this provider.'}}) && f.counts.db===0,'parser rejection');} // The parser's own refusal now names its reason with a fixed code and text (was the generic message).
    {const f=fixture(undefined,'db'); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.statusCode===400 && r.body.error.message==='Could not import credentials','database rejection');}
    {const f=fixture(); const r=await f.request(`Bearer ${ADMIN}`,{...body,credentials:''}); ok(r.statusCode===400 && r.body.error.message==='Invalid account parameters or credentials' && f.counts.parse===0,'validation rejection');}
    const revoked=Proxy.revocable({},{}); revoked.revoke();
    const hostile=new Proxy({}, {get(){throw Error(FAULT)},getPrototypeOf(){throw Error(FAULT)},ownKeys(){throw Error(FAULT)}});
    for (const signal of [undefined,null,false,0,'', FAULT,hostile,revoked.proxy]) {
      for (const failure of ['parse','db','encrypt','sql']) { const f=fixture(undefined,failure,[signal]); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.statusCode===400 && r.body.error.message==='Could not import credentials' && f.manager.active===0,'untrusted dependency failure'); }
      for (const failure of ['status','json',['json','destroy']]) { const f=fixture(undefined,failure,[signal]); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.destroyed===true && r.statuses.length===1 && r.statuses[0]===201 && f.manager.active===0 && !r.dispatchFailed,'response failure'); }
    }
    // Refusal reasons: only the parser's tagged refusal (parse stage) and the name's UNIQUE violation (store stage) change the answer.
    // A thrown value that merely resembles one, or carries it at the other stage, keeps the generic answer.
    const nameTaken = () => Object.assign(Error('UNIQUE constraint failed: upstream_accounts.name'), {code:'SQLITE_CONSTRAINT_UNIQUE'});
    {const f=fixture(undefined,'sql',[nameTaken()]); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.statusCode===409 && r.fields['cache-control']==='no-store' && JSON.stringify(r.body)===JSON.stringify({error:{code:'account_name_taken',message:'An account with this name already exists. Choose another name.'}}) && f.manager.active===0,'database rejection');}
    for (const [failure, signal] of [
      ['parse', nameTaken()], ['parse', Object.assign(Error(FAULT), {importCode:'account_name_taken'})], ['parse', Object.assign(Error(FAULT), {importCode:'unlisted_code'})],
      ['parse', Object.assign(Error(FAULT), {importCode:{toString(){ return 'admin_key_not_supported'; }}})], ['parse', {get importCode(){ throw Error(FAULT); }}],
      ['sql', Object.assign(Error(FAULT), {importCode:'admin_key_not_supported'})], ['sql', Object.assign(Error('UNIQUE constraint failed: upstream_accounts.id'), {code:'SQLITE_CONSTRAINT_UNIQUE'})],
      ['sql', Object.assign(Error('UNIQUE constraint failed: upstream_accounts.name'), {code:'SQLITE_CONSTRAINT_TRIGGER'})], ['sql', {code:'SQLITE_CONSTRAINT_UNIQUE', get message(){ throw Error(FAULT); }}],
    ]) { const f=fixture(undefined,failure,[signal]); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.statusCode===400 && JSON.stringify(r.body)===JSON.stringify({error:{message:'Could not import credentials'}}) && f.manager.active===0,'untrusted dependency failure'); }
    // A refusal is the handler's own response: if writing it fails, the socket is destroyed and no second (500) response is attempted.
    {const f=fixture(undefined,['sql','status'],[nameTaken()]); const r=await f.request(`Bearer ${ADMIN}`,body); ok(r.destroyed===true && r.statuses.length===1 && r.statuses[0]===409 && f.manager.active===0 && !r.dispatchFailed,'response failure');}
    {const f=fixture(undefined,'status'); const r=await f.request(`Bearer ${ADMIN}`,{...body,credentials:'not valid'}); ok(r.destroyed===true && r.statuses.length===1 && r.statuses[0]===400 && f.counts.db===0 && f.manager.active===0 && !r.dispatchFailed,'response failure');}
    ok(captures.some(entry => entry.source==='response' && entry.method==='201') && captures.some(entry => entry.source==='response' && entry.method==='400') && captures.some(entry => entry.source==='response' && entry.method==='500'), 'response capture coverage');
    ok(captures.some(entry => entry.source==='logger' && entry.method==='debug' && entry.text===inspect(['Admin authenticated'], {depth:null,maxStringLength:null,maxArrayLength:null,breakLength:Infinity,getters:false})), 'authentication logger coverage');
    ok(captures.every(entry => markers.every(marker => !containsMarker(entry.text,marker))), 'logs contain secret');
  } catch (error) {
    const known = ['account field failure','post stop admission','ownership checkpoint','mutation control','setHeader','getHeader','removeHeader','socket','connection','url','headers','dispatch failed','dispatch unmatched','response 500','response 400','parse not reached','parse no ownership','work missing at parse','work missing at db','work missing at encrypt','work missing at sql','work missing at json','terminal ownership','success response','success counters','authentication','post stop rejection','parser rejection','database rejection','logs contain secret'];
    known.push('validation rejection','untrusted dependency failure','response failure','drain timeout','unexpected dependency');
    let message; try { message=error?.message; } catch {}
    if (['setInterval is not defined','setTimeout is not defined','clearInterval is not defined'].includes(message)) message='missing timer';
    if (message==='Buffer is not defined') message='missing buffer';
    if (message==='URL is not defined') message='missing url';
    known.push('missing timer','missing buffer','missing url');
    process.stderr.write(known.includes(message) ? message : phase);
    process.exitCode=1;
  }
}
