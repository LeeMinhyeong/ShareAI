import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {prepareEvidence} from '../src/db/experimental-recovery-evidence.ts';
import {finishAttempt} from '../src/db/durable-ledger-foundation.ts';
const [file, action, role, release] = process.argv.slice(2);
const db=new Database(file,{timeout:0});
// Hold the actual API transaction after its callback but before commit.
if(role==='first') {
  const transaction=db.transaction.bind(db);
  db.transaction=fn=>transaction(function(...args) {
    const result=fn(...args);
    const state=db.prepare("SELECT state,revision FROM main.phase4_experimental_ledger_attempts WHERE id='a'").get();
    const count=db.prepare('SELECT count(*) AS n FROM main.phase4_experimental_recovery_evidence').get().n;
    process.send({event:'held',state,count,result});
    const deadline=Date.now()+10000;
    while(!existsSync(release)) {
      if(Date.now()>deadline) throw new Error('release timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
    return result;
  });
}
process.send({event:'ready'});
process.on('message',async message=>{
  if(message!=='go') return;
  try {
    let result, reportedBusy=false;
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      try {
        result = action==='evidence' ? prepareEvidence(db,{attemptId:'a',revision:1,actor:'123e4567-e89b-42d3-a456-426614174000',reason:'INVESTIGATE_OPEN'}) : finishAttempt(db,'a',1,'UNKNOWN_429');
        break;
      } catch(e) {
        if(!String(e.code).startsWith('SQLITE_BUSY')) throw e;
        if(!reportedBusy) { process.send({event:'busy'}); reportedBusy=true; }
        await new Promise(r=>setTimeout(r,10));
      }
    }
    if(result===undefined) throw new Error('writer timeout');
    process.send({event:'result',result},()=>{db.close();process.exit(0);});
  } catch(e) { console.error(e); db.close(); process.exit(1); }
});
