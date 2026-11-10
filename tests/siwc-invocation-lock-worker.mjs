import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { CredentialVault } from '../src/utils/encryption.ts';
const db = new Database(process.argv[2], {timeout: 150});
if (process.argv[3] === 'probe') {
  try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); process.exitCode = 2; }
  catch (e) { if (e.code !== 'SQLITE_BUSY') process.exitCode = 3; }
  db.close();
} else if (process.argv[3] === 'crash') {
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('locked\n');
  setInterval(() => { db.prepare('SELECT 1').get(); }, 1000);
} else {
  try { new SiwcStore(db, new CredentialVault()).logout('a'); } finally { db.close(); }
}
