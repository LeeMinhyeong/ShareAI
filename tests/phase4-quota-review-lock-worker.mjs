import Database from 'better-sqlite3';
const db=new Database(process.argv[2]);
db.exec('BEGIN IMMEDIATE');
process.send('locked');
process.on('message',message=>{
 if(message.fingerprint){db.prepare('UPDATE account_daily_reservations SET used=1 WHERE account_id=?').run(message.accountId);db.prepare('INSERT INTO oauth_refresh_intents(token_fingerprint,attempt_id,account_id,created_at) VALUES (?,?,?,?)').run(message.fingerprint,'fixture-attempt',message.accountId,new Date().toISOString());db.exec('COMMIT');}
 else db.exec('ROLLBACK');
 db.close();process.disconnect();
});
