import { requireInitializedDatabase } from './client.js';
import { assertExperimental429Schema } from './experimental-atomic-429-app.js';
import { AppStopwatch } from './experimental-app-stopwatch.js';

type Kind = 'upstream' | 'siwc';
type Key = {kind: Kind; account_id: string};
type Entry = {key: Key; stopwatch: AppStopwatch};

/** Isolated, manual-tick experiment. No routing hook or autonomous scheduler.
 * Fairness applies only to a stable finite set with repeated successful ticks;
 * continuously growing sets and a stopped process have no progress guarantee.
 * Capacity bounds retained observations and pageSize bounds returned candidates only.
 * Validation scans all restriction rows on each tick and stopwatch check; neither
 * workload nor elapsed time is bounded by these options. This prototype cannot
 * guarantee bounded work without a separately reviewed incremental validation design. */
export class CooldownCoordinator {
  private readonly capacity: number;
  private readonly pageSize: number;
  private readonly clock: () => bigint;
  private readonly entries = new Map<string, Entry>();
  private cursor?: Key;
  private active?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;

  constructor(options: {capacity: number; pageSize: number; clock?: () => bigint}) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1 || options.capacity > 100 ||
        !Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100 ||
        (options.clock !== undefined && typeof options.clock !== 'function')) throw new Error('Invalid coordinator options');
    this.capacity = options.capacity;
    this.pageSize = options.pageSize;
    const source = options.clock ?? process.hrtime.bigint;
    let last: bigint | undefined;
    // Every entry uses this same source. A bad sample invalidates all of their
    // observations, including samples made earlier in the current tick.
    this.clock = () => {
      try {
        const value = source();
        if (typeof value !== 'bigint' || value < 0n || (last !== undefined && value < last)) {
          throw new Error('Invalid monotonic clock');
        }
        last = value;
        return value;
      } catch (error) {
        last = undefined;
        this.entries.clear();
        this.cursor = undefined;
        throw error;
      }
    };
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Coordinator stopped'));
    if (this.active) return Promise.reject(new Error('Coordinator tick already in progress'));
    const controller = new AbortController();
    this.controller = controller;
    const operation = Promise.resolve().then(() => this.run(controller.signal));
    this.active = operation;
    return operation.finally(() => { this.active = undefined; this.controller = undefined; });
  }

  private async run(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const db = requireInitializedDatabase();
    if (!db.open || db.inTransaction) throw new Error('Requires open autocommit database');
    assertExperimental429Schema(db);
    for (const [id, entry] of this.entries) {
      signal.throwIfAborted();
      const status = await entry.stopwatch.check({signal, timeoutMs: 100});
      if (requireInitializedDatabase() !== db || !db.open || db.inTransaction) throw new Error('Shared database changed');
      if (status !== 'waiting') { this.entries.delete(id); continue; }
      const row = db.prepare('SELECT duration_ns FROM main.experimental_atomic_429_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(entry.key.kind, entry.key.account_id) as {duration_ns: bigint | null} | undefined;
      if (!row || row.duration_ns === null) this.entries.delete(id);
    }
    if (this.entries.size >= this.capacity) return;
    signal.throwIfAborted();
    const limit = Math.min(this.pageSize, this.capacity - this.entries.size);
    const rows = (this.cursor
      ? db.prepare('SELECT kind,account_id FROM main.experimental_atomic_429_restrictions WHERE duration_ns IS NOT NULL AND (kind > ? OR (kind = ? AND account_id > ?)) ORDER BY kind,account_id LIMIT ?').all(this.cursor.kind,this.cursor.kind,this.cursor.account_id,limit)
      : db.prepare('SELECT kind,account_id FROM main.experimental_atomic_429_restrictions WHERE duration_ns IS NOT NULL ORDER BY kind,account_id LIMIT ?').all(limit)) as Key[];
    if (!rows.length) { this.cursor = undefined; return; }
    for (const key of rows) {
      this.cursor = key;
      const id = JSON.stringify([key.kind,key.account_id]);
      if (this.entries.has(id)) continue;
      const stopwatch = new AppStopwatch(key.kind,key.account_id,this.clock);
      this.entries.set(id,{key,stopwatch});
      // Retain the stopwatch on errors, including SQLITE_BUSY; it owns the observation.
      const status = await stopwatch.check({signal,timeoutMs:100});
      if (status !== 'waiting') this.entries.delete(id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort(new Error('Coordinator stopped'));
    try { await this.active; } catch { /* interrupted work remains fail-closed */ }
    this.entries.clear();
  }
}
