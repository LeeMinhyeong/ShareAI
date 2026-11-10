import {dispatchOpenAttemptOnce} from '../src/db/durable-ledger-foundation.ts';
try {
  await dispatchOpenAttemptOnce(process.argv[2],'race',()=>{},()=>new Promise(resolve=>{
    process.send('started');
    process.once('message',()=>resolve('terminal'));
  }), result=>result==='terminal' ? 'SUCCESS' : undefined);
  process.send('done');
} catch(e) {process.send(`error:${e.message}`);}
process.disconnect();
