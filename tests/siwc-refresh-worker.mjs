import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';
const db = new Database(process.argv[2],{timeout:5000});
const vault = { encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v,'base64').toString() };
const store = new SiwcStore(db,vault);
process.send('ready');
process.once('message', async () => {
  try {
    await refreshSiwc(store,'a',store.readSnapshot('a'),async () => {
      process.send('sent');
      await new Promise(resolve => process.once('message',resolve));
      return Response.json({access_token:'rotated',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600});
    },Number(process.argv[3] ?? 30000));
    process.send('success');
  } catch { process.send('rejected'); }
  db.close();
  process.disconnect();
});
