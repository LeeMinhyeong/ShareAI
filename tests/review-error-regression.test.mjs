import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url), ts=require('typescript');
function load(path,deps={}) {const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const out={};vm.runInThisContext(`(function(exports,require){${code}\n})`)(out,n=>n==='node:async_hooks'?require(n):deps[n]);return out;}
test('revoked proxy is not inspected when claiming error capability',()=>{const {RequestWorkManager}=load('../src/request-work.ts');const m=new RequestWorkManager();const {proxy,revoke}=Proxy.revocable({},{});revoke();assert.doesNotThrow(()=>assert.equal(m.claimError(proxy),undefined));});
test('revoked proxy can be forwarded by an admitted dispatch',()=>{const {RequestWorkManager}=load('../src/request-work.ts');const m=new RequestWorkManager();const {proxy,revoke}=Proxy.revocable({},{});revoke();let received;assert.doesNotThrow(()=>m.ownedDispatch(scope=>scope.forwardError(proxy,e=>{received=e;scope.terminal()})));assert.ok(received);});
