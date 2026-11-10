import Database from 'better-sqlite3';
import {createLedgerQuotaReservation} from '../src/upstream/account-quota.ts';
const [file,serialized,id]=process.argv.slice(2);
const db=new Database(file,{timeout:5000,fileMustExist:true});
db.pragma('synchronous=FULL');
try {
  const operation=createLedgerQuotaReservation(JSON.parse(serialized),new AbortController().signal,id);
  db.transaction(operation).immediate(db);
  console.log('COMMITTED');
} catch (error) {
  if (/Ledger globally fenced/.test(String(error))) console.log('FENCED');
  else { console.error(error); process.exitCode=1; }
} finally { db.close(); }
