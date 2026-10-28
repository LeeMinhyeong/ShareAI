import { initDatabase, closeDatabase } from '../src/db/client.ts';
process.send('ready');
process.once('message', () => {
  process.send('attempting');
  try { initDatabase(); closeDatabase(); process.send('done', () => process.disconnect()); }
  catch (error) { console.error(error); process.exitCode=1; process.disconnect(); }
});
