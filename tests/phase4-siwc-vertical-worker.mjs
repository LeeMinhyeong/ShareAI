// Isolated test-only HTTP endpoint; never mounted in the application.
import express from 'express';
import {randomUUID} from 'node:crypto';
const {getDb}=await import('../src/db/client.ts');
const {CredentialVault}=await import('../src/utils/encryption.ts');
const {SiwcStore}=await import('../src/upstream/siwc-store.ts');
const {authenticateUser}=await import('../src/auth/user-auth.ts');
const {assertSiwcDispatchGate,siwcAccess}=await import('../src/upstream/forward-chat.ts');
const {createOpenAttemptCallback,dispatchOpenAttemptOnce}=await import('../src/db/durable-ledger-foundation.ts');
const {strictInference}=await import('../src/upstream/inference.ts');
const {settleInferenceStream}=await import('../src/upstream/sse-terminal-adapter.ts');
const db=getDb(), store=new SiwcStore(db,new CredentialVault(),{initialize:false});
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,init)=>{if(url!=='https://api.openai.com/v1/responses') throw new Error('Unexpected upstream');return originalFetch(process.env.TEST_PROVIDER_URL,init);};
let releaseSelection,releaseResult; process.on('message',m=>{if(m==='release') releaseSelection?.();if(m==='releaseResult') releaseResult?.();});
const app=express();app.use(express.json());
app.post('/experimental-chat',authenticateUser,async(req,res)=>{
 const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded){controller.abort();process.send?.('cancelled');}});
 try {
  const id=req.body.account;
  if(typeof id!=='string' || !siwcAccess(db,req.user.id,id)) return res.sendStatus(404);
  const snapshot=store.readSnapshot(id);
  if(!snapshot) return res.sendStatus(503);
  if(req.body.pause) {process.send?.('selected');await new Promise(resolve=>{releaseSelection=resolve;});releaseSelection=undefined;}
  controller.signal.throwIfAborted();
  const attempt=randomUUID();
  // Own the outer writer transaction: revalidate before inserting OPEN and do
  // not initiate external work until its commit has returned successfully.
  db.pragma('busy_timeout = 0'); db.pragma('synchronous = FULL');
  db.transaction(()=>{assertSiwcDispatchGate(db,req.user.id,id,snapshot,controller.signal);createOpenAttemptCallback(attempt)(db);}).immediate();
  if(req.body.pauseOpen) {process.send?.('opened');await new Promise(resolve=>{releaseSelection=resolve;});releaseSelection=undefined;}
  const inference=strictInference('openai',{kind:'siwc',token:snapshot.credential.accessToken},{model:'gpt-5',messages:[{role:'user',content:'hi'}]},undefined,controller.signal);
  const events=[];
  const result=await dispatchOpenAttemptOnce(db.name,attempt,writer=>assertSiwcDispatchGate(writer,req.user.id,id,snapshot,controller.signal),async()=>{const result=await settleInferenceStream(inference,e=>events.push(e),controller.signal);if(req.body.pauseResult){await new Promise(resolve=>{releaseResult=resolve;process.send?.('result');});releaseResult=undefined;}return result;},r=>r.outcome);
  if(result.outcome==='UNKNOWN_429') return res.sendStatus(429);
  res.json({events,terminal:result.terminal});
 } catch(error) {if(!res.destroyed) res.status(error.status===404?404:503).end();}
 finally {if(req.body.pause)process.send?.('handled');}
});
const server=app.listen(0,'127.0.0.1',()=>process.send?.({port:server.address().port}));
process.on('disconnect',()=>server.close(()=>process.exit(0)));
