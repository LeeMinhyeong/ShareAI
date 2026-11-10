import type Database from 'better-sqlite3';
import { requireInitializedDatabase } from './client.js';
import { withAsyncWriter } from './async-writer.js';
import { assertExperimental429Schema } from './experimental-atomic-429-app.js';
import { validExperimentalAccountId } from './experimental-429-account-id.js';

/** Prototype only: no scheduling, routing, provider integration, or restart persistence.
 * One instance tracks exactly one account. Restarting waits the full duration again.
 * Trusts the local monotonic clock and generation writers; not an admission fence. */
type Kind = 'upstream' | 'siwc';
type Row = {generation: bigint; duration_ns: bigint | null};
type Observation = {db: Database.Database; generation: bigint; duration: bigint; start: bigint; last: bigint};
type Status = 'absent' | 'waiting' | 'expired';
export class AppStopwatch {
  private observation?: Observation;
  private busy = false;
  constructor(private readonly kind: Kind, private readonly accountId: string,
    private readonly clock: () => bigint = process.hrtime.bigint) {
    if ((kind !== 'upstream' && kind !== 'siwc') || !validExperimentalAccountId(accountId) || typeof clock !== 'function') throw new Error('Invalid stopwatch input');
  }
  private read(db: Database.Database): Row | undefined {
    return db.prepare('SELECT generation,duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(this.kind,this.accountId) as Row | undefined;
  }
  private sample(min = 0n): bigint {
    try {
      const value = this.clock();
      if (typeof value !== 'bigint' || value < min) throw new Error('Invalid monotonic clock');
      return value;
    } catch (error) {
      this.observation = undefined;
      throw error;
    }
  }
  async check(options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<Status> {
    if (this.busy) throw new Error('Stopwatch check already in progress');
    this.busy = true;
    try {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;
      if (timeoutMs !== undefined &&
        (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)) {
        throw new Error('Invalid stopwatch timeout');
      }
      signal?.throwIfAborted();
      const shared = requireInitializedDatabase();
      if (!shared.open || shared.inTransaction) throw new Error('Requires open autocommit database');
      assertExperimental429Schema(shared);
      const row = this.read(shared);
      if (!row) { this.observation = undefined; return 'absent'; }
      if (row.duration_ns === null) { this.observation = undefined; return 'waiting'; }
      let observed = this.observation;
      if (!observed || observed.db !== shared || observed.generation !== row.generation || observed.duration !== row.duration_ns) {
        const start = this.sample();
        this.observation = {db:shared,generation:row.generation,duration:row.duration_ns,start,last:start};
        return 'waiting';
      }
      const now = this.sample(observed.last);
      observed.last = now;
      if (now - observed.start < observed.duration) return 'waiting';
      return await withAsyncWriter(db => {
        // The private callback runs inside the writer's own immediate transaction.
        // For :memory: that writer is shared; a distinct writer must not escape
        // an outer transaction newly opened on the shared connection.
        if (!shared.open || requireInitializedDatabase() !== shared || (db !== shared && shared.inTransaction)) throw new Error('Shared database changed');
        assertExperimental429Schema(shared);
        assertExperimental429Schema(db);
        const current = this.read(db);
        if (!current || current.generation !== observed!.generation || current.duration_ns !== observed!.duration) {
          this.observation = undefined;
          return current ? 'waiting' : 'absent';
        }
        const lockedNow = this.sample(observed!.last);
        observed!.last = lockedNow;
        if (lockedNow - observed!.start < observed!.duration) return 'waiting';
        const changes = db.prepare('DELETE FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=? AND generation=? AND duration_ns=?')
          .run(this.kind,this.accountId,observed!.generation,observed!.duration).changes;
        if (changes !== 1) throw new Error('Restriction compare-and-delete failed');
        this.observation = undefined;
        return 'expired';
      }, {timeoutMs, signal});
    } finally { this.busy = false; }
  }
}
