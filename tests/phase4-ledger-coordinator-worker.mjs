import {dispatchOpenAttemptOnce} from '../src/db/durable-ledger-foundation.ts';
process.send('ready');
process.once('message', async () => {
  try {
    await dispatchOpenAttemptOnce(process.argv[2], 'race', () => {}, () => {
      process.send('started');
      if (process.argv[3] === 'crash') process.exit(23);
      return Promise.resolve();
    });
    process.send('done');
  } catch (e) { process.send(`error:${e.code || e.message}`); }
  process.disconnect();
});
