// Test-only router simulation: this is not the production /v1 route.
import http from 'node:http';
import Database from 'better-sqlite3';
import { ExperimentalCooldowns, readClock } from '../scripts/experimental-monotonic-clock.mjs';
const db = new Database(process.env.DB_PATH);
const clock = { path: process.env.CLOCK_PATH, token: process.env.CLOCK_TOKEN };
let sampleBarrier = false, releaseSample;
const cooldowns = new ExperimentalCooldowns(db, clock, {
  maxAgeNs: 100000000n,
  sampleClock: async config => {
    const reading = await readClock(config);
    if (sampleBarrier) {
      sampleBarrier = false;
      await new Promise(resolve => { releaseSample = resolve; send('sampleReady'); });
    }
    return reading;
  },
});
db.exec('CREATE TABLE IF NOT EXISTS test_open (account TEXT PRIMARY KEY)');
const send = (event, data = {}) => process.send?.({ event, ...data });
let release;
const barrier = () => new Promise(resolve => { release = resolve; });
const retry = async fn => {
  for (let i = 0; i < 100; i++) {
    try { return await fn(); } catch (e) { if (!String(e.code).startsWith('SQLITE_BUSY')) throw e; send('writerBusy'); await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error('writer retry exhausted');
};
const server = http.createServer(async (_req, res) => {
  try {
    let selected;
    for (const account of ['A', 'B']) {
      if (!(await cooldowns.allowed(account))) continue;
      const claimed = await retry(() => db.transaction(() => {
        if (db.prepare('SELECT 1 FROM test_open WHERE account=?').get(account)) return false;
        db.prepare('INSERT INTO test_open VALUES (?)').run(account); return true;
      }).immediate());
      if (claimed) { selected = account; break; }
    }
    if (!selected) { res.writeHead(503).end(); return; }
    const response = await fetch(`${process.env.PROVIDER_URL}/${selected}`);
    if (response.status === 429) {
      const observed = await readClock(clock); // strictly after response headers
      send('observed', { account: selected, tick: String(observed.tick), epoch: observed.epoch });
      await barrier();
      await retry(async () => {
        if (!(await cooldowns.limit(selected, 1000000000n))) throw new Error('epoch mismatch');
      });
    }
    await retry(() => db.prepare('DELETE FROM test_open WHERE account=?').run(selected));
    res.writeHead(response.status, { 'x-account': selected }).end();
  } catch (e) { send('error', { error: String(e.stack || e) }); res.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1', () => { if (server.address().port === 20128) { send('error', { error: 'reserved test port' }); server.close(); return; } send('ready', { port: server.address().port }); });
process.on('message', async m => {
  try {
    if (m.op === 'wallJump') { Date.now = () => m.value; send('wallJump'); }
    if (m.op === 'release') { if (!release) throw new Error('not waiting'); release(); release = null; }
    if (m.op === 'releaseSample') { if (!releaseSample) throw new Error('sample not waiting'); releaseSample(); releaseSample = null; }
    if (m.op === 'sampleOperation') {
      sampleBarrier = m.pause;
      try {
        const result = m.operation === 'limit' ? await cooldowns.limit(m.account, 1000000000n) : await cooldowns.allowed(m.account);
        send('sampleResult', { result });
      } catch (e) { send('sampleResult', { error: e.message }); }
    }
    if (m.op === 'allowed') send('allowed', { result: await cooldowns.allowed(m.account) });
    if (m.op === 'stop') { server.close(() => { db.close(); process.disconnect(); }); }
  } catch (e) { send('error', { error: String(e.stack || e) }); }
});
