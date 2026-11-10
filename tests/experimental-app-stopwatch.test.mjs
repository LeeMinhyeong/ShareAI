import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

for (const mode of ['memory', 'timeout']) test(`in-memory stopwatch ${mode}`, () => {
  const scratch=realpathSync(process.env.TMPDIR);
  const dir=mkdtempSync(join(scratch,'app-stopwatch-memory-'));
  try {
    const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TMPDIR:scratch,TEMP:scratch,TMP:scratch,NODE_ENV:'test',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'};
    const worker=fileURLToPath(new URL('./experimental-app-stopwatch-memory-worker.mjs',import.meta.url));
    const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker,mode],{cwd:dir,env,encoding:'utf8',timeout:20000});
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('single-account stopwatch expires an app-schema restriction', () => {
  const scratch=realpathSync(process.env.TMPDIR);
  const dir=mkdtempSync(join(scratch,'app-stopwatch-'));
  try {
    const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TMPDIR:scratch,TEMP:scratch,TMP:scratch,NODE_ENV:'test',ENCRYPTION_KEY:'a'.repeat(64),ADMIN_API_KEY:'x'.repeat(20),PORT:'20100',LOG_LEVEL:'error',LOG_PRETTY:'false'};
    const worker=fileURLToPath(new URL('./experimental-app-stopwatch-worker.mjs',import.meta.url));
    const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker],{cwd:dir,env,encoding:'utf8',timeout:20000});
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
