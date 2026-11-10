import express from 'express';
import Database from 'better-sqlite3';
import http from 'node:http';
import {once} from 'node:events';
const [file, providerPort, mode] = process.argv.slice(2);
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:`sqlite:${file}`,ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),LOG_LEVEL:'error',PORT:'1',HOST:'127.0.0.1'});
const fetchNative=globalThis.fetch;
let fetchCalls=0;
globalThis.fetch=(url,options)=>{fetchCalls++;if(String(url)!=='https://api.openai.com/v1/responses') throw new Error('unexpected outbound endpoint'); if(mode==='throw'||mode==='stale')throw new Error('fixture-access-token-marker fixture-private-account-marker'); if(mode==='reject')return Promise.reject(new Error('fixture-access-token-marker fixture-private-account-marker')); return fetchNative(`http://127.0.0.1:${providerPort}/inference`,options);};
const {accountPool}=await import('../src/account-pool/manager.ts');
const {closeDatabase,getDb}=await import('../src/db/client.ts');
if(mode==='stale') {
 const record=accountPool.recordSiwcFailure.bind(accountPool);
 accountPool.recordSiwcFailure=(id,revision)=>{
  getDb().prepare('UPDATE siwc_credentials SET revision=? WHERE id=?').run('fixture-new-revision',id);
  record(id,'fixture-new-revision');
  record(id,revision);
 };
}
// Observe completion of the real route work, including forwardChat's async finally. The v1
// route returns synchronously and runs its handler in an owned request-work scope, which
// calls terminal() once the handler has settled.
const {requestWork}=await import('../src/request-work.ts');
const ownedDispatch=requestWork.ownedDispatch.bind(requestWork);
requestWork.ownedDispatch=dispatch=>ownedDispatch(scope=>dispatch({...scope,terminal(){scope.terminal();process.send?.({event:'done',state:accountPool.siwcFailureMarker('fixture-private-account-marker'),fetchCalls});}}));
const router=(await import('../src/routes/v1.ts')).default;
const select=accountPool.selectCandidate.bind(accountPool);
let release; const selectionBarrier=new Promise(r=>release=r);
accountPool.selectCandidate=async (...args)=>{const candidate=await select(...args);if(candidate?.kind!=='siwc'||candidate.id!=='fixture-private-account-marker') throw new Error('wrong selection');if(mode==='selection'){process.send({event:'selection'});await selectionBarrier;}return candidate;};
const exec=Database.prototype.exec;
let held=false, announced=false;
Database.prototype.exec=function(sql){
 if(mode==='open' && sql==='BEGIN IMMEDIATE' && !announced){
  const check=new Database(file,{readonly:true}); let open; try{open=check.prepare("SELECT 1 FROM siwc_account_attempts WHERE account_id='fixture-private-account-marker'").get();}finally{check.close();}
  if(open){held=true;announced=true;process.send({event:'open'});}
 }
 if(sql==='BEGIN IMMEDIATE' && held){const e=new Error('synthetic writer contention');e.code='SQLITE_BUSY';throw e;}
 return exec.call(this,sql);
};
const emit=http.ServerResponse.prototype.emit;
http.ServerResponse.prototype.emit=function(event,...args){if(event==='close'&&!this.writableEnded)process.send?.({event:'closed'});return emit.call(this,event,...args);};
const original=express.application.listen;let server,ready;const startup=new Promise(r=>ready=r);
express.application.listen=function(_port,_host,callback){server=original.call(this,0,'127.0.0.1',()=>{callback();ready();});return server;};
try{await import('../src/server.ts');}finally{express.application.listen=original;}
await startup;if(!server.listening||server.address().port===20128)throw new Error('bad server startup');
process.send({event:'ready',port:server.address().port});
process.on('message',m=>{if(m==='release'){held=false;release();}if(m==='stop')server.close(()=>{closeDatabase();process.disconnect();});});
