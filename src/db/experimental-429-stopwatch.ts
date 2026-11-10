import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Scratch-only demonstration: not connected to routing, providers, or migrations.
 * Caller must schedule checks; checkMany visits keys in stable key order and
 * checks admitted timers even if they disappear from the caller's list. Limit
 * bounds returned candidate checks, not the capacity-sized maintenance pass;
 * selecting candidates scans the input once per returned candidate.
 * A new process starts over, including after reboot. Without a long-lived observer
 * or later check a cooldown can remain blocked indefinitely. No wall-clock or
 * cross-process clock epoch is used. Restoring/rolling back the DB or VM is out
 * of scope; SQLite and the local monotonic clock must be trustworthy and must
 * not advance faster than real elapsed time. Suspend behavior varies by platform;
 * a clock that pauses during suspend only extends the restriction. All writers
 * must use arm() and preserve the generation history; direct SQL edits are outside
 * this prototype's trust boundary. Generation history grows without bound.
 * This is not an admission/dispatch fence; expiry must not itself authorize a call.
 * Unknown/invalid duration is represented by NULL and never expires. HTTP-date
 * without a trustworthy provider Date has no inferable duration. This prototype
 * applies no fallback and handles no 5xx. Durations are integer nanoseconds,
 * capped at signed 64-bit max. This is not a production schema or authorization.
 */
type Db = Database.Database;
type Row = { generation: string; duration: string | null };
const max = 9223372036854775807n;
function duration(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null;
  return BigInt(value) <= max ? value : null;
}
function noTransaction(db: Db): void {
  if (db.inTransaction) throw new Error('Requires autocommit connection');
}
export function initialize(db: Db): void {
  noTransaction(db);
  db.exec(`CREATE TABLE experimental_429_generations (generation TEXT PRIMARY KEY);
    CREATE TABLE experimental_429_restrictions (
      kind TEXT NOT NULL, account_id TEXT NOT NULL, generation TEXT NOT NULL,
      duration TEXT, PRIMARY KEY(kind, account_id),
      FOREIGN KEY(generation) REFERENCES experimental_429_generations(generation));`);
}
/** The caller supplies an already-derived full duration; invalid means indefinite. */
export function arm(db: Db, kind: string, id: string, requiredNs: unknown): string {
  noTransaction(db);
  if (!kind || !id) throw new Error('Invalid account key');
  return db.transaction(() => {
    const previous = db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(kind, id) as Row | undefined;
    const incoming = duration(requiredNs);
    const prior = previous ? duration(previous.duration) : undefined;
    const effective = previous
      ? (prior === null || incoming === null ? null : (BigInt(prior!) >= BigInt(incoming) ? prior! : incoming))
      : incoming;
    const generation = randomUUID();
    db.prepare('INSERT INTO experimental_429_generations VALUES (?)').run(generation);
    db.prepare(`INSERT INTO experimental_429_restrictions VALUES (?,?,?,?)
      ON CONFLICT(kind,account_id) DO UPDATE SET generation=excluded.generation,duration=excluded.duration`)
      .run(kind, id, generation, effective);
    return generation;
  }).immediate();
}
type Observation = { generation: string; duration: string; start: bigint };
type AccountKey = { kind: string; id: string };
type Status = 'absent' | 'waiting' | 'expired';
export class Stopwatch {
  private readonly observations = new Map<string, Observation>();
  private cursor: string | undefined;
  // Finite stable repeatedly polled sets progress if DB operations succeed,
  // time advances, and admitted restrictions are not continually re-armed.
  // There is no FIFO or liveness guarantee under an ever-growing population.
  constructor(private readonly db: Db, private readonly clock: () => bigint = process.hrtime.bigint,
    private readonly capacity = 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid observation capacity');
  }
  checkMany(keys: readonly AccountKey[], limit: number): Array<AccountKey & { status: Status }> {
    noTransaction(this.db);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error('Invalid tick limit');
    // Service admitted observations first, including keys no longer in the input.
    // check() rereads the actual row and uses the normal writer/CAS path.
    const serviced = new Map<string, Status>();
    for (const key of Array.from(this.observations.keys())) {
      const [kind, id] = JSON.parse(key) as [string, string];
      serviced.set(key, this.check(kind, id));
    }
    const count = Math.min(limit, keys.length);
    const results: Array<AccountKey & { status: Status }> = [];
    for (let i = 0; i < count; i++) {
      // Scan without retaining the caller's potentially unbounded input. Stable
      // ordering prevents changes in list order from pinning a numeric cursor.
      let next: AccountKey | undefined;
      let nextKey: string | undefined;
      let first: AccountKey | undefined;
      let firstKey: string | undefined;
      for (const key of keys) {
        if (!key.kind || !key.id) throw new Error('Invalid account key');
        const encoded = JSON.stringify([key.kind, key.id]);
        if (firstKey === undefined || encoded < firstKey) { first = key; firstKey = encoded; }
        if ((this.cursor === undefined || encoded > this.cursor) && (nextKey === undefined || encoded < nextKey)) {
          next = key; nextKey = encoded;
        }
      }
      const key = next ?? first!;
      const encoded = nextKey ?? firstKey!;
      const status = serviced.get(encoded) ?? this.check(key.kind, key.id);
      this.cursor = encoded;
      results.push({ ...key, status });
    }
    return results;
  }
  check(kind: string, id: string): Status {
    noTransaction(this.db);
    if (!kind || !id) throw new Error('Invalid account key');
    const key = JSON.stringify([kind, id]);
    const row = this.db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(kind,id) as Row | undefined;
    if (!row) { this.observations.delete(key); return 'absent'; }
    const d = duration(row.duration);
    if (d === null || typeof row.generation !== 'string' || !row.generation) { this.observations.delete(key); return 'waiting'; }
    const old = this.observations.get(key);
    if (!old || old.generation !== row.generation || old.duration !== d) {
      if (!old && this.observations.size >= this.capacity) return 'waiting';
      const start = this.clock();
      if (typeof start !== 'bigint' || start < 0n) throw new Error('Invalid monotonic clock');
      this.observations.delete(key);

      this.observations.set(key, { generation: row.generation, duration: d, start });
      // Even zero-duration observations go through the writer transaction on a later check.
      return 'waiting';
    }
    return this.db.transaction(() => {
      // All validation and the clock sample happen after the actual writer lock.
      const current = this.db.prepare('SELECT generation,duration FROM experimental_429_restrictions WHERE kind=? AND account_id=?').get(kind,id) as Row | undefined;
      if (!current || current.generation !== old.generation || current.duration !== old.duration) {
        this.observations.delete(key);
        return current ? 'waiting' : 'absent';
      }
      const now = this.clock();
      if (typeof now !== 'bigint' || now < old.start) { this.observations.delete(key); throw new Error('Invalid monotonic clock'); }
      if (now - old.start < BigInt(old.duration)) return 'waiting';
      const result = this.db.prepare('DELETE FROM experimental_429_restrictions WHERE kind=? AND account_id=? AND generation=? AND duration=?')
        .run(kind,id,old.generation,old.duration);
      this.observations.delete(key);
      return result.changes === 1 ? 'expired' : 'waiting';
    }).immediate();
  }
}
