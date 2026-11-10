import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
const db = new Database(process.argv[2], {timeout:5000});
const vault = process.argv[3] === 'encrypted-logout' ? new (await import('../src/utils/encryption.ts')).CredentialVault() : {encrypt:v=>Buffer.from(v).toString('base64'), decrypt:v=>Buffer.from(v,'base64').toString()};
const store = new SiwcStore(db, vault);
if (process.argv[3] === 'encrypted-logout') {
  const result = store.logout(process.argv[4]);
  process.send({remoteUncertain:result.remoteUncertain});
  db.close(); process.disconnect();
} else {
if (process.argv[3] === 'authorization') store.claimAuthorization('a', store.readRegistrationSnapshot('a').revision);
else store.claimRefresh('a', store.readSnapshot('a'));
process.send('claimed');
process.on('message', () => { db.close(); process.disconnect(); });
}
