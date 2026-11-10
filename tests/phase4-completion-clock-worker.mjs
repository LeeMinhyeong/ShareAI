import Database from 'better-sqlite3';
import {writeFileSync} from 'node:fs';
const db=new Database(process.argv[2],{timeout:0});
db.exec('BEGIN IMMEDIATE');
writeFileSync(process.argv[3],'locked');
process.on('message',()=>{db.exec('COMMIT');db.close();process.disconnect();});
