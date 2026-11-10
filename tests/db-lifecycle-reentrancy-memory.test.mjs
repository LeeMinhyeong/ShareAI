// Synthetic in-memory SQLite only; exercise the actual transpiled client and writer.
// The configured path is a plain (never opened) file name because the client refuses in-memory
// paths (ADR 0018); the injected constructor always returns an in-memory handle.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript'), Database = require('better-sqlite3');
const compile = p => ts.transpileModule(readFileSync(new URL(p, import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const load = (code,deps) => { const exports={}; vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports,n=>{if(!(n in deps)) throw Error(`unexpected ${n}`);return deps[n]}); return exports; };
// Reentrancy, not schema safety, is under test: the v2 guards are inert here.
const v2Stub={assert429V2Schema(){}, provision429V2(){}};
const clientCode=compile('../src/db/client.ts'), writerCode=compile('../src/db/async-writer.ts'), schemaCode=compile('../src/db/schema.ts'), storeCode=compile('../src/upstream/siwc-store.ts');
function setup(mode) {
  let client, shared, raw, fire = false, writer, begins=0, commits=0, rolledBack=false, initTransaction=false;
  const handles=[];
  class Injected {
    constructor() {
      const db=new Database(':memory:'); handles.push(db);
      if(handles.length===1) raw=db; else writer=db;
      return new Proxy(db,{get(target,p) {
        if(p==='name' && ['separate','commit-uncertain','rollback-error','writer-close-throw','writer-close-secret','writer-close-silent','writer-close-after','writer-open-throw'].includes(mode)) return 'synthetic-file';
        if(target===raw && p==='open' && mode==='close-getter' && fire===true) {fire=false; client.closeDatabase()}
        if(target===raw && p==='close' && mode==='close-method' && fire===true) return () => {fire=false; client.closeDatabase(); target.close()};
        if(target===raw && p==='close' && mode==='close-method-failure' && fire===true) return () => {client.closeDatabase(); throw false};
        if(target===writer && p==='close' && fire===true) return () => {if(mode==='writer-close-secret') throw Error('synthetic-secret'); if(mode==='writer-close-after') {target.close(); throw false} if(mode==='writer-close-throw') throw false; if(mode==='writer-close-silent') return; target.close()};
        if(target===writer && p==='open' && fire===true && mode==='writer-open-throw') throw null;
        if(p==='inTransaction' && typeof fire === 'number' && fire > 0 && --fire === 0) {try {client.closeDatabase()} catch {} }
        if(p==='prepare' && mode==='init' && !fire) {fire=true; client.closeDatabase();}
        if(p==='transaction' && (mode==='init' || mode==='init-tx')) return fn=>{const tx=target.transaction(()=>{initTransaction=true; return fn()}); return {immediate(){const outer=!target.inTransaction; const result=tx.immediate(); if(outer) commits++; return result}}};
        if(p==='exec' && target===raw && mode==='init-tx') return sql=>{const result=target.exec(sql); if(initTransaction && !fire){fire=true; client.closeDatabase()} return result};
        if(p==='exec' && target===writer) return sql=>{if(sql==='BEGIN IMMEDIATE') begins++; if(sql==='COMMIT') {commits++; if(mode==='commit-uncertain'){target.exec(sql); throw false;}} if(sql==='ROLLBACK') {target.exec(sql); rolledBack=!target.inTransaction && !target.prepare("SELECT 1 FROM sqlite_schema WHERE name='t'").get(); if(mode==='rollback-error') throw null; return target;} return target.exec(sql)};
        const v=Reflect.get(target,p,target); return typeof v==='function'?v.bind(target):v;
      }});
    }
  }
  const schema=load(schemaCode,{}), store=load(storeCode,{'better-sqlite3':{default:Injected},'node:crypto':require('node:crypto')});
  client=load(clientCode,{'better-sqlite3':{default:Injected},'../config/env.js':{env:{DATABASE_URL:'sqlite:synthetic-reentrancy.db'}},'../utils/logger.js':{logger:{info(){}}},'./schema.js':schema,'../upstream/siwc-store.js':store,'./account-429-v2-store.js':v2Stub,'path':{default:{dirname:()=>'.'}},'fs':{default:{existsSync:()=>true}}});
  const writerModule=load(writerCode,{'better-sqlite3':{default:Injected},'./client.js':client,'../utils/logger.js':{logger:{error(){}}}});
  return {client,writerModule, init(){shared=client.getDb();return shared}, raw:()=>raw, writer:()=>writer, arm(){fire=3}, fault(){fire=true}, disarm(){fire=false}, counts:()=>({begins,commits,rolledBack}), cleanup(){for(const db of handles) if(db.open) db.close()}};
}
for (const mode of ['close-getter','close-method']) test(`shutdown handles ${mode} reentrancy`,()=>{
  const f=setup(mode); try {f.init(); f.fault(); f.client.closeDatabase(); assert.equal(f.raw().open,false); assert.throws(()=>f.client.getDb(),/closed/i)} finally {f.cleanup()}
});
test('reentrant singleton close failure retains ownership and falsey error',()=>{
  const f=setup('close-method-failure'); try {f.init(); f.fault(); let threw=false, caught;
    try {f.client.closeDatabase()} catch(e) {threw=true; caught=e}
    assert.equal(threw,true); assert.equal(caught,false); assert.equal(f.raw().open,true);
    assert.throws(()=>f.client.getDb(),/quarantin/i); f.disarm(); f.client.closeDatabase();
    assert.equal(f.raw().open,false); assert.throws(()=>f.client.getDb(),/closed/i);
  } finally {f.cleanup()}
});
for (const mode of ['writer-close-throw','writer-close-silent','writer-close-after','writer-open-throw']) test(`writer retains uncertain ownership: ${mode}`,()=>{
  const f=setup(mode); try {f.init(); f.fault(); let calls=0, caught, threw=false;
    try {assert.equal(f.writerModule.withAsyncWriter(db=>{calls++;db.exec('CREATE TABLE t(x)'); return 42}),42)} catch(e) {threw=true;caught=e}
    assert.equal(threw,false, 'confirmed commit must retain its successful outcome'); assert.equal(calls,1);
    if(mode!=='writer-close-after') {
      assert.throws(()=>f.writerModule.withAsyncWriter(()=>{calls++}),/quarantin/i);
      assert.throws(()=>f.writerModule.retryQuarantinedWriters(),/cleanup failed/i);
      assert.throws(()=>f.writerModule.withAsyncWriter(()=>{calls++}),/quarantin/i);
      assert.equal(calls,1); f.disarm(); f.writerModule.retryQuarantinedWriters(); assert.equal(f.writer().open,false);
      assert.equal(f.writerModule.withAsyncWriter(()=>42),42);
    } else { f.disarm(); assert.equal(f.writerModule.withAsyncWriter(()=>42),42); }
  } finally {f.cleanup()}
});
test('cleanup exceptions do not leak through writer failure or quarantine retry',()=>{
  const f=setup('writer-close-secret'); const primary=Error('primary');
  try { f.init(); f.fault(); let failure, retry;
    try {f.writerModule.withAsyncWriter(()=>{throw primary})} catch(e) {failure=e}
    try {f.writerModule.retryQuarantinedWriters()} catch(e) {retry=e}
    assert.ok(failure instanceof AggregateError); assert.equal(failure.errors[0],primary);
    const inspect=require('node:util').inspect;
    assert.equal(inspect(failure,{depth:10}).includes('synthetic-secret'),false);
    assert.equal(inspect(retry,{depth:10}).includes('synthetic-secret'),false);
    f.disarm(); f.writerModule.retryQuarantinedWriters();
  } finally {f.cleanup()}
});
test('writer preserves falsey primary and close failures',()=>{
  const f=setup('writer-close-throw'); try {f.init(); f.fault(); let caught;
    try {f.writerModule.withAsyncWriter(()=>{throw null})} catch(e) {caught=e}
    assert.ok(caught instanceof AggregateError); assert.equal(caught.errors[0],null);
    assert.ok(caught.errors[1] instanceof Error); assert.equal(caught.errors[1].message,'Writer cleanup failed');
    assert.throws(()=>f.writerModule.withAsyncWriter(()=>{}),/quarantin/i);
    f.disarm(); f.writerModule.retryQuarantinedWriters();
  } finally {f.cleanup()}
});
test('callback shutdown prevents separate writer commit and rolls back',()=>{
  const f=setup('separate'); try { f.init(); let calls=0;
    assert.throws(()=>f.writerModule.withAsyncWriter(db=>{calls++;db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)'); f.client.closeDatabase()}),/initialized|closed|closing/i);
    assert.equal(calls,1); assert.equal(f.counts().commits,0); assert.equal(f.counts().rolledBack,true); assert.equal(f.writer().open,false);
  } finally {f.cleanup()}
});
test('reentrant transaction getter shutdown prevents BEGIN',()=>{
  const f=setup('separate'); try {f.init(); f.arm(); let calls=0;
    assert.throws(()=>f.writerModule.withAsyncWriter(()=>{calls++}),/initialized|closed/i);
    assert.equal(calls,0); assert.equal(f.counts().begins,0);
  } finally {f.cleanup()}
});
test('in-memory shutdown during callback cannot commit or reopen',()=>{
  const f=setup('memory'); try {const db=f.init(); db.exec('CREATE TABLE probe(n)'); let calls=0;
    assert.throws(()=>f.writerModule.withAsyncWriter(writer=>{calls++; writer.exec('INSERT INTO probe VALUES (1)'); try {f.client.closeDatabase()} catch {} }),/initialized|closed/i);
    assert.equal(calls,1); assert.equal(f.raw().open,false);
    assert.throws(()=>f.client.getDb(),/quarantin|closed/i);
  } finally {f.cleanup()}
});
test('rollback failure retains both falsey primary and cleanup errors',()=>{
  const f=setup('rollback-error'); try {f.init(); let caught, threw=false;
    try { f.writerModule.withAsyncWriter(()=>{throw false}) } catch(e) {threw=true; caught=e}
    assert.equal(threw,true); assert.ok(caught instanceof AggregateError); assert.deepEqual(caught.errors,[false,null]);
  } finally {f.cleanup()}
});
test('simulated lost commit acknowledgement is not replayed',()=>{
  const f=setup('commit-uncertain'); try {f.init(); let calls=0, caught, threw=false;
    try {f.writerModule.withAsyncWriter(db=>{calls++;db.exec('CREATE TABLE t(x)')})} catch(e) {threw=true;caught=e}
    assert.equal(threw,true); assert.equal(caught?.message,'Writer commit outcome is unknown'); assert.equal(calls,1); assert.equal(f.counts().commits,1); assert.equal(f.writer().open,false);
  } finally {f.cleanup()}
});
test('shutdown inside initialization transaction rolls it back',()=>{
  const f=setup('init-tx'); try {assert.throws(()=>f.client.initDatabase(),/closing|closed/i); assert.equal(f.counts().commits,0); assert.equal(f.raw().open,false)} finally {f.cleanup()}
});
test('shutdown during initialization preflight prevents migration commit',()=>{
  const f=setup('init'); try {assert.throws(()=>f.client.initDatabase(),/closing|closed/i); assert.equal(f.counts().commits,0); assert.equal(f.raw().open,false)} finally {f.cleanup()}
});
