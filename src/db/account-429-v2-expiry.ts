import type Database from 'better-sqlite3';
import { requireInitializedDatabase } from './client.js';
import { withAsyncWriter } from './async-writer.js';
import { assert429V2Schema } from './account-429-v2-store.js';

type Db = Database.Database;
type Kind = 'upstream' | 'siwc';
type Row = {kind: Kind; account_id: string; generation: bigint; duration_ms: bigint | null};
type Observation = {row: Row; since: bigint};
export interface Account429V2ExpiryOptions {
  /** Receives the first sanitized failure; must be installed before start. */
  onFailure: (error: Error) => void;
  /** Monotonic nanoseconds, shared by all observations in this instance. */
  monotonic: () => bigint;
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  intervalMs: number;
  maxObservations: number;
  scanBatch: number;
}

/** Conservative, process-local observation of committed v2 restriction durations. */
export class Account429V2Expiry {
  private readonly o: Account429V2ExpiryOptions;
  private readonly abort = new AbortController();
  private readonly stopReason = new Error('Expiry stopped');
  private readonly observations = new Map<string, Observation>();
  private observedDatabase: Db | null = null;
  private cursor: [string, string] | null = null;
  private lastClock: bigint | null = null;
  private timer: unknown = undefined;
  private timerPresent = false;
  private running = false;
  private stopped = false;
  private failed = false;
  private flight: Promise<void> | null = null;
  private drain: Promise<void> | null = null;

  constructor(options: Account429V2ExpiryOptions) {
    if (typeof options.onFailure !== 'function') throw new Error('Invalid expiry configuration');
    for (const n of [options.intervalMs, options.maxObservations, options.scanBatch]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid expiry configuration');
    }
    this.o = options;
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    try {
      // Also contain a rejected promise returned by an async observer.
      void Promise.resolve(this.o.onFailure(new Error(message))).catch(() => {});
    } catch { /* Observer failures cannot escape scheduler handling. */ }
  }

  private sample(): bigint {
    let now: unknown;
    try { now = this.o.monotonic(); } catch { this.observations.clear(); this.lastClock = null; throw new Error('Expiry clock failure'); }
    if (typeof now !== 'bigint' || now < 0n || (this.lastClock !== null && now < this.lastClock)) {
      this.observations.clear(); this.lastClock = null; throw new Error('Expiry clock failure');
    }
    this.lastClock = now;
    return now;
  }

  private key(row: Row): string { return JSON.stringify([row.kind, row.account_id]); }
  private validate(raw: unknown, counter: bigint): Row {
    const r = raw as Record<string, unknown>;
    if (!r || (r.kind !== 'upstream' && r.kind !== 'siwc') || typeof r.account_id !== 'string' ||
        typeof r.generation !== 'bigint' || r.generation <= 0n || r.generation > counter ||
        !(r.duration_ms === null || (typeof r.duration_ms === 'bigint' && r.duration_ms >= 0n && r.duration_ms <= BigInt(Number.MAX_SAFE_INTEGER)))) {
      throw new Error('Invalid expiry data');
    }
    return r as Row;
  }
  private same(a: Row, b: Row): boolean { return a.generation === b.generation && a.duration_ms === b.duration_ms; }

  private async work(): Promise<void> {
    if (this.stopped) return;
    const before = requireInitializedDatabase();
    if (this.observedDatabase !== null && this.observedDatabase !== before) throw new Error('Expiry database changed');
    await withAsyncWriter(db => {
    if (this.stopped) return;
    const shared = requireInitializedDatabase();
    if (shared !== before || (this.observedDatabase !== null && this.observedDatabase !== shared)) throw new Error('Expiry database changed');
    this.observedDatabase = shared;
    const counter = assert429V2Schema(db);
    // Re-read every retained entry so deletion, null rearm, and changed generations
    // release capacity even when they lie behind the keyset scan cursor.
    for (const [key, observation] of this.observations) {
      if (this.stopped) return;
      const raw = db.prepare('SELECT kind, account_id, generation, duration_ms FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(observation.row.kind, observation.row.account_id);
      if (!raw) { this.observations.delete(key); continue; }
      const row = this.validate(raw, counter);
      const now = this.sample();
      if (!this.same(row, observation.row)) {
        if (row.duration_ms === null) this.observations.delete(key);
        else this.observations.set(key, {row, since: now});
        continue;
      }
      if (row.duration_ms === null || now - observation.since < row.duration_ms * 1000000n) continue;
      const lockedNow = this.sample();
      if (lockedNow - observation.since < row.duration_ms * 1000000n) continue;
      db.prepare('DELETE FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=? AND generation=? AND duration_ms=?').run(row.kind, row.account_id, row.generation, row.duration_ms);
      // Keep observation on CAS miss; next pass reconciles and restarts it.
    }
    if (this.stopped) return;
    const cursor = this.cursor;
    const rows = db.prepare(`SELECT kind, account_id, generation, duration_ms FROM main.account_429_v2_restrictions
      WHERE (? IS NULL OR kind COLLATE BINARY > ? COLLATE BINARY OR (kind = ? COLLATE BINARY AND account_id COLLATE BINARY > ? COLLATE BINARY))
      ORDER BY kind COLLATE BINARY, account_id COLLATE BINARY LIMIT ?`).safeIntegers().all(cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, this.o.scanBatch);
    if (rows.length === 0) { this.cursor = null; return; }
    for (const raw of rows) {
      const row = this.validate(raw, counter);
      this.cursor = [row.kind, row.account_id];
      const key = this.key(row);
      if (row.duration_ms === null || this.observations.has(key) || this.observations.size >= this.o.maxObservations) continue;
      this.observations.set(key, {row, since: this.sample()});
    }
    }, {signal: this.abort.signal});
    if (!this.stopped && requireInitializedDatabase() !== before) throw new Error('Expiry database changed');
  }

  /** Coalesces concurrent calls. A failed tick stops automatic scheduling. */
  tick(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.stopped || this.failed) return Promise.reject(new Error('Expiry service unavailable'));
    const flight = Promise.resolve().then(() => this.work()).catch((error: unknown) => {
      if (this.stopped && error === this.stopReason) return;
      this.fail('Expiry tick failed');
      throw new Error('Expiry tick failed');
    }).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight;
    return flight;
  }
  private schedule(): void {
    if (this.stopped || this.failed || !this.running) return;
    const handle = this.o.setTimer(() => {
      this.timerPresent = false;
      if (this.stopped || this.failed) return;
      void this.tick().then(() => { if (!this.stopped) this.schedule(); }).catch(() => { this.fail('Expiry timer failed'); });
    }, this.o.intervalMs);
    if (this.stopped || this.failed) this.o.clearTimer(handle);
    else { this.timer = handle; this.timerPresent = true; }
  }
  start(): void {
    if (this.stopped || this.failed) throw new Error('Expiry service unavailable');
    if (this.running) return;
    this.running = true;
    try { this.schedule(); } catch { this.fail('Expiry timer failed'); throw new Error('Expiry timer failed'); }
  }
  /** Idempotent shared drain; no DB callbacks are admitted after stop. */
  stopAndDrain(): Promise<void> {
    if (this.drain) return this.drain;
    this.stopped = true;
    this.running = false;
    let resolve!: () => void, reject!: (reason: Error) => void;
    const drain = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.drain = drain;
    let clearFailed = false;
    try { this.abort.abort(this.stopReason); } catch { clearFailed = true; }
    if (this.timerPresent) {
      this.timerPresent = false;
      try { this.o.clearTimer(this.timer); } catch { clearFailed = true; }
    }
    void Promise.resolve().then(async () => {
      if (this.flight) { try { await this.flight; } catch { /* surfaced below */ } }
      // Let an in-flight tick report its own failure before reporting cleanup.
      if (clearFailed) this.fail('Expiry service failed');
      if (clearFailed || this.failed) reject(new Error('Expiry service failed'));
      else resolve();
    });
    return drain;
  }
}
