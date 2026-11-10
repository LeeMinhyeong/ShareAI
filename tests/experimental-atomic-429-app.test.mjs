import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('actual writer commits experimental settlement on isolated application schema',()=>{
  const scratch=realpathSync(process.env.TMPDIR);
  const dir=mkdtempSync(join(scratch,'atomic-429-app-'));
  try {
    const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TMPDIR:scratch,TEMP:scratch,TMP:scratch,
      NODE_ENV:'test',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'};
    const worker=fileURLToPath(new URL('./experimental-atomic-429-app-worker.mjs',import.meta.url));
    const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker],{cwd:dir,env,encoding:'utf8',timeout:15000});
    assert.ifError(result.error);
    assert.equal(result.status,0,`worker failed: ${result.stderr}`);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
