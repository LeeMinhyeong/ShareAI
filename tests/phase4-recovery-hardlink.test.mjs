import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';

const cli=fileURLToPath(new URL('../scripts/offline-open-recovery.mjs',import.meta.url));
const flags=['--routers-stopped','--provider-no-inflight','--backup-verified','--accept-unverified-remote-evidence'];
const attempt='12345678-1234-4123-8123-123456789abc';

test('offline recovery rejects a hard-linked DB and preserves both fences and restrictions',async()=>{
  const root=process.env.TMPDIR;
  assert.ok(typeof root==='string' && path.isAbsolute(root),'absolute trusted TMPDIR required');
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(root),'shareai-recovery-link-'));
  const file=path.join(dir,'fixture.sqlite'),alias=path.join(dir,'fixture-alias.sqlite');
  const children=[],handles=[];let uncertain=false;
  function open(name=file,options={fileMustExist:true}){const db=new Database(name,options);handles.push(db);return db;}
  function close(db){if(db.open)db.close();if(db.open)throw new Error('fixture database close uncertain');}
  function snapshot(db){
    const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
    const quote=s=>'"'+s.replaceAll('"','""')+'"';
    const rows=Object.fromEntries(schema.filter(x=>x.type==='table').map(({name})=>[name,db.prepare(`SELECT rowid,* FROM main.${quote(name)} ORDER BY rowid`).safeIntegers().all()]));
    return {schema,rows,journal:db.pragma('journal_mode',{simple:true})};
  }
  async function run(args){
    const child=spawn(process.execPath,[cli,...args],{cwd:dir,env:{SystemRoot:process.env.SystemRoot??''},stdio:['ignore','pipe','pipe'],windowsHide:true});
    const record={closed:false};children.push(record);let stdout='',stderr='',bytes=0,overflow=false,timedOut=false,spawnError=false,streamError=false,closeTimer;
    child.on('error',()=>{spawnError=true;});child.stdout.on('error',()=>{streamError=true;});child.stderr.on('error',()=>{streamError=true;});
    const collect=(kind,chunk)=>{bytes+=chunk.length;if(bytes>65536){overflow=true;child.kill();return;}if(kind==='out')stdout+=chunk.toString();else stderr+=chunk.toString();};
    child.stdout.on('data',c=>collect('out',c));child.stderr.on('data',c=>collect('err',c));
    let rejectClose;const done=new Promise((resolve,reject)=>{rejectClose=reject;child.once('close',(code,signal)=>{record.closed=true;resolve({code,signal});});});
    const timer=setTimeout(()=>{timedOut=true;child.kill();closeTimer=setTimeout(()=>{uncertain=true;child.stdout.destroy();child.stderr.destroy();child.unref();rejectClose(new Error('fixture child close unconfirmed'));},5000);},10000);
    let result;try{result=await done;}finally{clearTimeout(timer);clearTimeout(closeTimer);}
    assert.equal(spawnError,false,'fixture child spawn failed');assert.equal(streamError,false,'fixture child stream failed');assert.equal(overflow,false,'fixture output limit');assert.equal(timedOut,false,'fixture child timed out');
    return {...result,stdout,stderr};
  }
  try{
    let db=open(file,{});
    db.exec(`CREATE TABLE ordinary_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
      CREATE TABLE ordinary_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
      CREATE TABLE siwc_account_attempts (account_id TEXT NOT NULL PRIMARY KEY, attempt_id TEXT NOT NULL);
      CREATE TABLE siwc_attempts_schema_marker (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
      CREATE TABLE account_429_cooldowns (kind TEXT,account_id TEXT,until_at INTEGER);
      CREATE TABLE account_429_v2_restrictions (kind TEXT,account_id TEXT,generation INTEGER,duration_ms INTEGER);
      INSERT INTO ordinary_attempts_schema_marker VALUES(1,1);INSERT INTO siwc_attempts_schema_marker VALUES(1,1);
      INSERT INTO ordinary_account_attempts VALUES('a','${attempt}');INSERT INTO siwc_account_attempts VALUES('s','${attempt}');
      INSERT INTO account_429_cooldowns VALUES('upstream','a',123);INSERT INTO account_429_v2_restrictions VALUES('upstream','a',1,6000);`);
    close(db);
    let result=await run(['initialize-audit','--db',file,'--audit-never-provisioned',...flags]);
    assert.equal(result.code,0,'audit setup failed');assert.equal(result.signal,null);
    db=open();const before=snapshot(db);close(db);
    fs.linkSync(file,alias);assert.equal(fs.statSync(file,{bigint:true}).nlink,2n);
    const recover=['recover','--db',file,'--kind','ordinary','--account-id','a','--attempt-id',attempt,'--actor','fixture-operator','--reason','REMOTE_COMPLETED',...flags];
    result=await run(recover);assert.equal(result.code,1,'hard-linked recovery must be refused');assert.equal(result.signal,null);
    assert.ok(result.stderr.includes('Offline operation refused or failed'),'expected refusal missing');
    for(const name of [file,alias]){db=open(name,{fileMustExist:true,readonly:true});assert.deepEqual(snapshot(db),before);close(db);}
    fs.unlinkSync(alias);
    result=await run(recover);assert.equal(result.code,0,'single-link recovery failed');assert.equal(result.signal,null);
    db=open();assert.deepEqual(db.prepare('SELECT * FROM ordinary_account_attempts').all(),[]);
    assert.deepEqual(db.prepare('SELECT * FROM siwc_account_attempts').all(),[{account_id:'s',attempt_id:attempt}]);
    assert.deepEqual(db.prepare('SELECT * FROM account_429_cooldowns').all(),[{kind:'upstream',account_id:'a',until_at:123}]);
    assert.deepEqual(db.prepare('SELECT * FROM account_429_v2_restrictions').all(),[{kind:'upstream',account_id:'a',generation:1,duration_ms:6000}]);
    assert.deepEqual(before.rows.offline_open_recovery_audit,[]);
    assert.deepEqual(db.prepare('SELECT kind,account_id,attempt_id,actor,reason,status FROM offline_open_recovery_audit').all(),[{kind:'ordinary',account_id:'a',attempt_id:attempt,actor:'fixture-operator',reason:'REMOTE_COMPLETED',status:'CLEARED'}]);close(db);
  }finally{
    for(const {closed} of children)if(!closed)uncertain=true;
    for(const db of handles){try{close(db);}catch{uncertain=true;}}
    if(!uncertain)fs.rmSync(dir,{recursive:true});else console.error(`Fixture cleanup uncertain; retained: ${dir}`);
    assert.equal(uncertain,false,'fixture cleanup uncertain; directory retained');
  }
});
