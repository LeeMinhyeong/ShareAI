import Database from 'better-sqlite3';
import { serveClock, ExperimentalCooldowns } from '../scripts/experimental-monotonic-clock.mjs';
const { ROLE, CLOCK_PATH, CLOCK_TOKEN, DB_PATH } = process.env;
let ticks = 0n, wall = 0, service, db, cooldowns;
const config = { path: CLOCK_PATH, token: CLOCK_TOKEN };
const ready = (async () => {
  if (ROLE === 'clock') service = await serveClock({ ...config, now: () => ticks });
  else if (ROLE === 'realclock') service = await serveClock(config);
  else { db = new Database(DB_PATH); db.pragma('busy_timeout = 1000'); cooldowns = new ExperimentalCooldowns(db, config); }
})();
process.on('message', async m => {
  try {
    await ready;
    let value = null;
    switch (m.op) {
      case 'ready': break;
      case 'wallJump': wall += m.delta; Date.now = () => wall; break;
      case 'advance': ticks += BigInt(m.ticks); break;
      case 'limit': value = await cooldowns.limit(m.account, BigInt(m.duration)); break;
      case 'allowed': value = await cooldowns.allowed(m.account); break;
      case 'stop': if (service) await service.close(); if (db) db.close(); process.send({ id: m.id, value }); process.disconnect(); return;
      default: throw new Error('invalid operation');
    }
    process.send({ id: m.id, value });
  } catch (e) { process.send({ id: m.id, error: String(e.stack || e) }); }
});
