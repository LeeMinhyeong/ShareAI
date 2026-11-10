import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { CredentialVault } from '../src/utils/encryption.ts';
const db = new Database(process.argv[2], {timeout:5000});
try { db.pragma('synchronous = FULL'); new SiwcStore(db,new CredentialVault()).logout('a'); }
finally { db.close(); }
