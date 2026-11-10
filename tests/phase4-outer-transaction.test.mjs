import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// In-memory SQLite is unsupported (ADR 0018); db:init/db:migrate rejection is covered by phase1-migrate.
for (const mode of ['file']) {
  test(`active outer transaction refuses writer and provider (${mode})`, async () => {
    const worker=fileURLToPath(new URL('./phase4-outer-transaction-worker.mjs',import.meta.url));
    const child=fork(worker,[mode],{execArgv:['--import',import.meta.resolve('tsx')],stdio:['ignore','pipe','pipe','ipc']});
    let stderr='', result;
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('message',message=>{result=message;});
    const exit=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(new Error(`${mode} worker timeout`));},15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    assert.equal(exit.code,0,`${mode} worker failed (${exit.signal}): ${stderr}`);
    assert.deepEqual(result,{mode,passed:true});
  });
}
