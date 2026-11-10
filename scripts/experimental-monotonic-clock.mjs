// Experimental only. Not integrated with the router or a production database.
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_TICK = 9223372036854775807n;
const validTick = s => typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) <= MAX_TICK;
const tokenOk = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Injection allows a separately hosted virtual source in tests, never an IPC clock-control command.
export async function serveClock({ path, token, now = () => process.hrtime.bigint() }) {
  if (typeof token !== 'string' || token.length < 64 || !path) throw new Error('invalid clock configuration');
  const epoch = randomBytes(32).toString('hex');
  const server = net.createServer(socket => {
    socket.setTimeout(1000, () => socket.destroy());
    let input = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (!tokenOk(request.token, token) || request.op !== 'read') return socket.destroy();
        const tick = now();
        if (typeof tick !== 'bigint' || !validTick(String(tick))) return socket.destroy();
        socket.end(JSON.stringify({ epoch, tick: String(tick) }) + '\n');
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  return { epoch, close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}

// Each operation uses a new connection and response; callers must treat rejection as unavailable.
export function readClock({ path, token, timeoutMs = 1000 }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint(); let input = ''; let settled = false;
    const socket = net.createConnection(path);
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeoutMs, () => finish(new Error('clock timeout')));
    socket.on('error', e => finish(e));
    socket.on('connect', () => socket.write(JSON.stringify({ op: 'read', token }) + '\n'));
    socket.on('data', chunk => {
      input += chunk.toString('utf8');
      if (input.length > 4096) return finish(new Error('oversized clock response'));
      if (!input.includes('\n')) return;
      try {
        const v = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (!/^[0-9a-f]{64}$/.test(v.epoch) || !validTick(v.tick)) throw new Error('invalid clock response');
        finish(null, { epoch: v.epoch, tick: BigInt(v.tick), started });
      } catch (e) { finish(e); }
    });
    socket.on('end', () => finish(new Error('clock closed without response')));
  });
}

// Synchronous SQLite transaction, but asynchronous clock read is always outside it.
export class ExperimentalCooldowns {
  constructor(db, clock, { maxAgeNs = 1000000000n, marginNs = 0n, sampleClock = readClock } = {}) {
    if (typeof maxAgeNs !== 'bigint' || maxAgeNs <= 0n || typeof marginNs !== 'bigint' || marginNs < 0n || typeof sampleClock !== 'function') throw new Error('invalid safety settings');
    this.db = db; this.clock = clock; this.maxAgeNs = maxAgeNs; this.marginNs = marginNs; this.sampleClock = sampleClock;
    // Never wait synchronously for a competing SQLite writer; the caller may retry asynchronously.
    db.pragma('busy_timeout = 0');
    db.exec('CREATE TABLE IF NOT EXISTS experimental_cooldown (account TEXT PRIMARY KEY, epoch TEXT NOT NULL, deadline INTEGER NOT NULL CHECK(typeof(deadline) = \'integer\' AND deadline >= 0))');
    this.get = db.prepare('SELECT epoch, deadline FROM experimental_cooldown WHERE account = ?').safeIntegers();
    this.put = db.prepare('INSERT INTO experimental_cooldown(account, epoch, deadline) VALUES (?, ?, ?) ON CONFLICT(account) DO UPDATE SET epoch=excluded.epoch, deadline=excluded.deadline');
  }
  // The trusted sampler supplies a clock reading, not its age: measure age locally
  // from before sampling so a delayed or inaccurate callback cannot reset it.
  async sample() {
    const started = process.hrtime.bigint();
    const reading = await this.sampleClock(this.clock);
    if (!reading || typeof reading.epoch !== 'string' || !/^[0-9a-f]{64}$/.test(reading.epoch) || typeof reading.tick !== 'bigint' || !validTick(String(reading.tick))) throw new Error('invalid clock response');
    return { epoch: reading.epoch, tick: reading.tick, started };
  }
  fresh(reading) { const age = process.hrtime.bigint() - reading.started; return age >= 0n && age <= this.maxAgeNs; }
  async limit(account, durationNs) {
    if (typeof account !== 'string' || !account || typeof durationNs !== 'bigint' || durationNs <= 0n || durationNs > MAX_TICK) throw new Error('invalid cooldown');
    const reading = await this.sample(); // Must be called after the 429 observation.
    const deadline = reading.tick + durationNs + this.marginNs;
    if (deadline > MAX_TICK) throw new Error('deadline overflow');
    return this.db.transaction(() => {
      if (!this.fresh(reading)) throw new Error('stale clock reading');
      const previous = this.get.get(account);
      if (previous && previous.epoch !== reading.epoch) return false; // unresolved prior epoch is never overwritten
      this.put.run(account, reading.epoch, previous && previous.deadline > deadline ? previous.deadline : deadline);
      return true;
    }).immediate();
  }
  async allowed(account) {
    try {
      if (typeof account !== 'string' || !account) return false;
      const reading = await this.sample();
      return this.db.transaction(() => {
        if (!this.fresh(reading)) return false;
        const row = this.get.get(account);
        return !row || (row.epoch === reading.epoch && reading.tick >= row.deadline);
      }).immediate();
    } catch { return false; }
  }
}
