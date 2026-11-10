import {test} from 'node:test';
import assert from 'node:assert/strict';
import {streamDiagnostic,workerFailureDiagnostic} from './siwc-fixture-diagnostics.mjs';

function assertSafeDiagnostic(produce,expected) {
 let actual;
 try {
  actual=produce();
 } catch {
  assert.fail('diagnostic helper unexpectedly threw');
 }
 assert.ok(actual===expected,'diagnostic did not match the allowed fixed output');
}

test('worker error text is never rendered at either former truncation boundary',()=>{
 const secrets=['fixture-key','fixture-id','token-g','a'.repeat(64),'x'.repeat(20),'0123456789abcdef'.repeat(4),'unknown-sensitive-value'];
 for(const boundary of [8192,65536]) for(const secret of secrets) for(const offset of [-secret.length,-3,0,3]) {
  const error=new Error('z'.repeat(boundary+offset)+secret+'z'.repeat(100));
  assertSafeDiagnostic(()=>workerFailureDiagnostic(error),'fixture worker failed; inspect the synthetic fixture and its startup dependencies');
 }
});

test('worker failure diagnostic is constant for different thrown values',()=>{
 const sensitive='unknown-sensitive-value';
 const values=[new Error(sensitive),new TypeError(sensitive),new AggregateError([new Error(sensitive)],sensitive),
  sensitive,{message:sensitive},null,undefined,0,false,Symbol(sensitive),
  {get message(){throw new Error(sensitive);},toString(){throw new Error(sensitive);}}];
 for(const value of values) {
  assertSafeDiagnostic(()=>workerFailureDiagnostic(value),'fixture worker failed; inspect the synthetic fixture and its startup dependencies');
 }
});

test('stream categories never expose child bytes across chunks, limits or UTF-8 splits',()=>{
 const secrets=['fixture-key','fixture-id','token-g','a'.repeat(64),'x'.repeat(20),'0123456789abcdef'.repeat(4),'unknown-sensitive-value'];
 for(const truncated of [false,true]) {
  assertSafeDiagnostic(()=>streamDiagnostic({chunks:[],truncated}),
   'no child output'+(truncated?'\n[output truncated]':''));
 }
 for(const [prefix,category] of [['startup import failure ','startup import failure'],['ordinary child output ','child output omitted']]) {
  for(const secret of secrets) for(const boundary of [8192,65536]) {
   for(const [position,offset] of [['within',-secret.length-3],['crossing',-3],['excluded',0]]) {
    const content=Buffer.from(prefix+'z'.repeat(boundary-prefix.length+offset)+secret+'€');
    const start=content.indexOf(Buffer.from(secret));
    const cut=content.subarray(0,boundary);
    const split=position==='excluded' ? boundary-1 : start+1;
    const parts=[cut.subarray(0,split),cut.subarray(split)];
    assert.ok(Buffer.concat(parts).equals(cut),'chunks must exactly partition the captured bytes');
    assert.ok(position==='within' ? start+secret.length<=boundary :
     position==='crossing' ? start<boundary && start+secret.length>boundary : start>=boundary,
     'secret must occupy the intended position relative to the cut');
    assert.ok(position==='excluded' || (start<split && split<Math.min(start+secret.length,boundary)),
     'captured secret bytes must span chunks');
    assertSafeDiagnostic(()=>streamDiagnostic({chunks:parts,truncated:true}),category+'\n[output truncated]');
    const euro=content.length-2;
    const fullParts=[content.subarray(0,start+1),content.subarray(start+1,euro),content.subarray(euro)];
    assert.ok(Buffer.concat(fullParts).equals(content),'chunks must exactly partition the full bytes');
    assertSafeDiagnostic(()=>streamDiagnostic({chunks:fullParts,truncated:false}),category);
   }
  }
 }
});
