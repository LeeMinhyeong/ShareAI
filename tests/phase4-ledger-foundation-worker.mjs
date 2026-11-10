import Database from 'better-sqlite3';
import {openAttempt} from '../src/db/durable-ledger-foundation.ts';
const [file,action,id]=process.argv.slice(2);
const db=new Database(file,{timeout:0,fileMustExist:true});
const opened=openAttempt(db,id);
console.log(opened?'OPEN':'BLOCKED');
if(action==='hold' && opened) setInterval(()=>{},1000);
else db.close();
