import Database from 'better-sqlite3';
import {armAndSettle} from '../src/db/experimental-atomic-429-settle.ts';
const db=new Database(process.argv[2],{fileMustExist:true,timeout:5000});
process.send('ready');
process.once('message',()=>{
  try { const n=armAndSettle(db,{kind:'upstream',accountId:'race',attemptId:'owner',durationNs:50n}); process.send({ok:true,generation:String(n)}); }
  catch(e) { process.send({ok:false,error:String(e)}); }
  finally { db.close(); process.disconnect(); }
});
