import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const worker=fileURLToPath(new URL('./siwc-local-cooldown-reselect-worker.mjs',import.meta.url));
for (const owned of [false,true]) test(`worker rejects ${owned?'existing owned fixture':'unowned cwd'} before opening database`,()=>{
 const root=process.env.TMPDIR;
 assert.ok(root && path.isAbsolute(root));
 const dir=mkdtempSync(path.join(root,owned?'siwc-local-race-':'siwc-sentinel-'));
 const file=path.join(dir,'fixture.sqlite'), token=randomBytes(32).toString('hex');
 try {
  writeFileSync(path.join(dir,'.siwc-fixture-owner'),token,{flag:'wx'});
  writeFileSync(file,'synthetic sentinel',{flag:'wx'});
  const env={...process.env,SIWC_FIXTURE_ROOT:root,SIWC_FIXTURE_OWNER:token};
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker,file],{cwd:dir,env,encoding:'utf8',timeout:10000});
  assert.ifError(result.error);
  assert.notEqual(result.status,0);
  assert.equal(result.stderr.trim(),'SIWC fixture validation failed');
  assert.equal(readFileSync(file,'utf8'),'synthetic sentinel');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

for (const scenario of ['unowned-directory','wrong-marker','wrong-file']) test(`worker rejects ${scenario} without creating a database`,()=>{
 const root=process.env.TMPDIR;
 const dir=mkdtempSync(path.join(root,scenario==='unowned-directory'?'siwc-sentinel-':'siwc-local-race-'));
 const token=randomBytes(32).toString('hex'), fixture=path.join(dir,'fixture.sqlite');
 const file=scenario==='wrong-file'?path.join(dir,'other.sqlite'):fixture;
 try {
  writeFileSync(path.join(dir,'.siwc-fixture-owner'),scenario==='wrong-marker'?'wrong':token,{flag:'wx'});
  const env={...process.env,SIWC_FIXTURE_ROOT:root,SIWC_FIXTURE_OWNER:token};
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker,file],{cwd:dir,env,encoding:'utf8',timeout:10000});
  assert.ifError(result.error);
  assert.notEqual(result.status,0);
  assert.equal(result.stderr.trim(),'SIWC fixture validation failed');
  assert.equal(existsSync(file),false);
  assert.equal(existsSync(fixture),false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
