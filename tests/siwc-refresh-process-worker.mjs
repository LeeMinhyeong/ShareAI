import Database from 'better-sqlite3';
import { SiwcStore } from '../src/upstream/siwc-store.ts';
import { refreshSiwc } from '../src/upstream/siwc-refresh.ts';
const db = new Database(process.argv[2], {timeout:5000});
const vault = {encrypt:v=>Buffer.from(v).toString('base64'),decrypt:v=>Buffer.from(v,'base64').toString()};
const store = new SiwcStore(db,vault);
const snapshot = store.readSnapshot('a');
const observe = SiwcStore.prototype.observeRefresh;
let announced = false;
SiwcStore.prototype.observeRefresh = function (...args) { const state = observe.apply(this,args); if (!announced && state.status === 'pending') { announced = true; process.send({type:'waiting'}); } return state; };
process.send({type:'ready'});
process.once('message', async () => {
  process.send({type:'started'});
  try {
    const value = await refreshSiwc(store,'a',snapshot,async () => {
      process.send({type:'provider'});
      await new Promise(resolve => process.once('message',resolve));
      return Response.json({access_token:'rotated',refresh_token:'rotated-refresh',token_type:'Bearer',expires_in:3600});
    },12000);
    process.send({type:'success',value});
  } catch (error) { process.send({type:'error',message:error.message}); }
  db.close(); process.disconnect();
});
