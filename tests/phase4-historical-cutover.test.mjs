import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';
import {runOffline429} from '../scripts/offline-429-upgrade.mjs';

const flags=['--backup-verified','--all-routers-stopped','--no-outstanding-work','--legacy-schema-provenance-verified','--single-host-trusted-directory'];
const openFlags=['--all-routers-stopped','--no-outstanding-work','--backup-verified','--genuinely-pre-open'];
const openCli=fileURLToPath(new URL('../scripts/offline-open-upgrade.mjs',import.meta.url));

const schema=fs.readFileSync(new URL('../scripts/legacy-740df93-schema.sql',import.meta.url),'utf8');

// Parent owns each direct child and removes its directory only after every close.
test('historical initialized DB crosses both cutovers and starts a separate initializer',async()=>{
  const root=process.env.TMPDIR;
  assert.ok(typeof root==='string' && path.isAbsolute(root),'absolute trusted TMPDIR required');
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(root),'shareai-history-'));
  const file=path.join(dir,'fixture.sqlite');
  const children=[], handles=[];let uncertain=false;
  const open=(options={fileMustExist:true})=>{const db=new Database(file,options);handles.push(db);return db;};
  const close=db=>{if(db.open)db.close();if(db.open)throw new Error('fixture database close uncertain');};
  const snapshot=db=>{
    const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const tables=schema.filter(x=>x.type==='table').map(x=>x.name);
    const q=s=>'"'+s.replaceAll('"','""')+'"';
    return {schema,rows:Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT rowid,* FROM main.${q(t)} ORDER BY rowid`).safeIntegers().all()])),journal:db.pragma('journal_mode',{simple:true})};
  };
  async function run(args,env) {
    const child=spawn(process.execPath,args,{cwd:dir,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const record={child,closed:false};children.push(record);
    let stdout='',stderr='',bytes=0,overflow=false,timedOut=false,spawnError=false,streamError=false,closeTimer;
    child.on('error',()=>{spawnError=true;});
    child.stdout.on('error',()=>{streamError=true;});child.stderr.on('error',()=>{streamError=true;});
    const collect=(which,chunk)=>{bytes+=chunk.length;if(bytes>65536){overflow=true;child.kill();return;}if(which==='out')stdout+=chunk.toString();else stderr+=chunk.toString();};
    child.stdout.on('data',c=>collect('out',c));child.stderr.on('data',c=>collect('err',c));
    let rejectClose;
    const done=new Promise((resolve,reject)=>{rejectClose=reject;child.once('close',(code,signal)=>{record.closed=true;resolve({code,signal});});});
    const timer=setTimeout(()=>{timedOut=true;child.kill();closeTimer=setTimeout(()=>{uncertain=true;child.stdout.destroy();child.stderr.destroy();child.unref();rejectClose(new Error('fixture child close unconfirmed'));},5000);},10000);
    let result;
    try {result=await done;} finally {clearTimeout(timer);clearTimeout(closeTimer);}
    assert.equal(spawnError,false,'fixture child spawn failed');assert.equal(streamError,false,'fixture child stream failed');
    assert.equal(overflow,false,'fixture child output exceeded bound');assert.equal(timedOut,false,'fixture child timed out');
    return {...result,stdout,stderr};
  }
  const basic={SystemRoot:process.env.SystemRoot ?? ''};
  try {
    let db=open({});db.exec(schema);db.exec(`INSERT INTO quota_migration_marker VALUES(1);
      INSERT INTO users(id,api_key_hash,name,email,tier) VALUES('u','synthetic-hash','synthetic','fixture@example.invalid','free');
      INSERT INTO upstream_accounts(id,name,provider,credential_type,credentials,status,quota_reset_at) VALUES('a','synthetic','openai','api_key','synthetic-only','active','2020-01-01');
      INSERT INTO usage_logs(id,user_id,upstream_account_id,timestamp,model,provider,input_tokens,output_tokens,success,latency_ms) VALUES('large','u','a','2020-01-01 00:00:00','fixture','openai',9007199254740993,0,1,1);
      INSERT INTO user_daily_quota VALUES('u','2020-01-01',1);
      INSERT INTO oauth_refresh_intents VALUES('synthetic-fingerprint','synthetic-attempt','a','2020-01-01');
      INSERT INTO account_pool_rules(id,user_id,provider,model_pattern,allowed_account_ids,selection_strategy) VALUES('r','u','openai','*','["a"]','priority');
      INSERT INTO settings VALUES('synthetic','fixture');`);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);const historical=snapshot(db);close(db);
    const denied=await run([openCli,file],basic);
    assert.equal(denied.code,1);assert.equal(denied.signal,null);assert.match(denied.stderr,/Required operator attestations/);
    db=open();assert.deepEqual(snapshot(db),historical);close(db);
    const alias=path.join(dir,'fixture-alias.sqlite');
    fs.linkSync(file,alias);assert.equal(fs.statSync(file,{bigint:true}).nlink,2n);
    const linked=await run([openCli,...openFlags,file],basic);
    assert.equal(linked.code,1,'hard-linked OPEN upgrade must be refused');assert.equal(linked.signal,null);
    assert.ok(linked.stderr.includes('Offline upgrade refused or failed'),'hard-linked OPEN refusal diagnostic missing');
    for(const name of [file,alias]){db=new Database(name,{fileMustExist:true,readonly:true});handles.push(db);assert.deepEqual(snapshot(db),historical);close(db);}
    fs.unlinkSync(alias);
    const preparedResult=await run([openCli,...openFlags,file],basic);
    assert.equal(preparedResult.code,0,'historical OPEN cutover failed');assert.equal(preparedResult.signal,null);
    assert.match(preparedResult.stdout,/Offline OPEN schema provisioned/);
    db=open();const prepared=snapshot(db);for(const t of Object.keys(historical.rows))assert.deepEqual(prepared.rows[t],historical.rows[t]);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='account_429_cooldowns'").get().n,0);close(db);
    const plain={fs,path,platform:process.platform,openDatabase(p,options){assert.equal(p,file);return open(options);}};
    assert.throws(()=>runOffline429([...flags,file],plain),/Unsafe offline 429 migration/);
    db=open();assert.deepEqual(snapshot(db),prepared);close(db);
    const historicalFlags=[...flags,'--genuinely-pre-429',file];
    db=open();db.exec('CREATE VIEW unexpected_fixture_view AS SELECT 1');const tampered=snapshot(db);close(db);
    assert.throws(()=>runOffline429(historicalFlags,plain),/Unsafe historical pre-429 baseline/);
    db=open();assert.deepEqual(snapshot(db),tampered);db.exec('DROP VIEW unexpected_fixture_view');
    db.exec('DELETE FROM quota_migration_marker');const missingMarker=snapshot(db);close(db);
    assert.throws(()=>runOffline429(historicalFlags,plain),/Unsafe historical pre-429 baseline/);
    db=open();assert.deepEqual(snapshot(db),missingMarker);db.exec('INSERT INTO quota_migration_marker VALUES(1)');
    assert.deepEqual(snapshot(db),prepared);close(db);
    let reachedRollback=false;
    const fault={...plain,openDatabase(p,options){const actual=plain.openDatabase(p,options);return new Proxy(actual,{get(obj,key){
      if(key==='exec')return sql=>{if(sql.startsWith('CREATE TABLE main.account_429_v2_schema_marker')){
        reachedRollback=obj.inTransaction && !!obj.prepare("SELECT 1 FROM sqlite_schema WHERE name='account_429_cooldowns'").get();
        throw new Error('synthetic failure after historical cooldown creation');
      }return obj.exec(sql);};
      const value=obj[key];return typeof value==='function'?value.bind(obj):value;
    }});}};
    assert.throws(()=>runOffline429(historicalFlags,fault),/synthetic failure after historical cooldown creation/);
    assert.equal(reachedRollback,true);db=open();assert.deepEqual(snapshot(db),prepared);close(db);
    let missingObserved=false;
    try {
      runOffline429(historicalFlags,{fs,path,platform:process.platform,openDatabase(p,options){
        assert.equal(p,file);const actual=open(options);
        return new Proxy(actual,{get(obj,key){
          if(key==='prepare')return sql=>{
            const statement=obj.prepare(sql);
            if(sql!=='SELECT type,name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE')return statement;
            return new Proxy(statement,{get(s,k){
              if(k==='get')return (...args)=>{const result=s.get(...args);if(args[0]==='account_429_cooldowns' && !result)missingObserved=true;return result;};
              const value=s[k];return typeof value==='function'?value.bind(s):value;
            }});
          };
          const value=obj[key];return typeof value==='function'?value.bind(obj):value;
        }});
      }});
    } catch(error) {
      assert.equal(missingObserved,true,'failure did not reach missing legacy cooldown check');
      assert.equal(error?.message,'Unsafe offline 429 migration','unexpected failure category');
      throw error;
    }
    db=open();const converted=snapshot(db);
    assert.deepEqual(converted.rows.usage_logs.map(({usage_known,...r})=>{assert.equal(usage_known,null);return r;}),historical.rows.usage_logs);
    assert.equal(converted.rows.usage_logs[0].input_tokens,9007199254740993n);close(db);
    // Native Node TypeScript transformation plus a narrow .js -> .ts resolver
    // avoids a transpiler service process in the initializer child.
    const sourceRoot=new URL('../src/',import.meta.url).href;
    const loaderFile=path.join(dir,'fixture-loader.mjs');
    fs.writeFileSync(loaderFile,`import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';export async function resolve(specifier,context,next){if(context.parentURL?.startsWith(${JSON.stringify(sourceRoot)}) && /^\\.\\.?\\/.*\\.js$/.test(specifier)){const target=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(target.href.startsWith(${JSON.stringify(sourceRoot)}) && existsSync(fileURLToPath(target)))return next(target.href,context);}return next(specifier,context);}`,{flag:'wx'});
    const clientUrl=new URL('../src/db/client.ts',import.meta.url).href;
    const script=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';const deny=()=>{throw new Error('fixture operation denied')};for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=deny;net.connect=net.createConnection=deny;net.createServer=deny;net.Socket.prototype.connect=deny;net.Server.prototype.listen=deny;tls.connect=tls.createServer=deny;tls.TLSSocket.prototype.connect=deny;tls.Server.prototype.listen=deny;http.request=http.get=https.request=https.get=deny;globalThis.fetch=deny;syncBuiltinESMExports();const n=await import('node:net'),t=await import('node:tls'),h=await import('node:http'),c=await import('node:child_process');if(n.connect!==deny||t.connect!==deny||h.request!==deny||c.spawn!==deny)throw new Error('fixture guard mismatch');const {initDatabase,closeDatabase}=await import(${JSON.stringify(clientUrl)});initDatabase();closeDatabase();console.log('HISTORICAL_START_OK');`;
    const started=await run(['--experimental-transform-types','--experimental-loader',pathToFileURL(loaderFile).href,'--input-type=module','-e',script],{...basic,NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'00'.repeat(32),ADMIN_API_KEY:'fixture-administrator-key',LOG_LEVEL:'error',LOG_PRETTY:'false',NODE_NO_WARNINGS:'1'});
    assert.equal(started.code,0,'separate initializer failed');assert.equal(started.signal,null);assert.ok(started.stdout.trim()==='HISTORICAL_START_OK','initializer completion marker mismatch');
    db=open();const after=snapshot(db);assert.deepEqual(after.rows.usage_logs,converted.rows.usage_logs);
    for(const t of Object.keys(historical.rows))if(t!=='usage_logs')assert.deepEqual(after.rows[t],historical.rows[t]);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);close(db);
  } finally {
    for(const {closed} of children)if(!closed)uncertain=true;
    for(const db of handles){try{close(db);}catch{uncertain=true;}}
    if(!uncertain)fs.rmSync(dir,{recursive:true});
    else console.error(`Fixture cleanup uncertain; retained: ${dir}`);
    assert.equal(uncertain,false,'fixture cleanup uncertain; directory retained');
  }
});
