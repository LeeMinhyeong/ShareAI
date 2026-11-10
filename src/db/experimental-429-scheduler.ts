// Isolated experiment. Supply a fresh, exclusively owned coordinator per scheduler.
// A failed constructor does not take ownership or stop the supplied coordinator.
// Lifetime is soft:
// a stuck or synchronous tick/stop cannot be preempted; work is not bounded.
// All tick errors are terminal. SQLite busy auto-retry is deferred until error
// provenance can be proven; an arbitrary error's code is not proof. The
// validated backoff options are reserved and have no effect while retry is off.
type Coordinator = { tick(): Promise<void>; stop(): Promise<void> };
type Timers = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
type Options = { timers: Timers; intervalMs: number; maxAttempts: number; lifetimeMs: number; backoffMs: number; maxBackoffMs: number };

export class Experimental429Scheduler {
  private started = false;
  private stopping = false;
  private run?: Promise<void>;
  private timer?: {id: unknown; wake: () => void};
  private lastNow?: number;
  private readonly completion: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  constructor(private readonly coordinator: Coordinator, private readonly options: Options) {
    const {intervalMs, maxAttempts, lifetimeMs, backoffMs, maxBackoffMs, timers} = options;
    if (!coordinator || typeof coordinator.tick !== 'function' || typeof coordinator.stop !== 'function' ||
        !timers || typeof timers.now !== 'function' || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function' ||
        !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
        ![intervalMs, lifetimeMs, backoffMs, maxBackoffMs].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 2147483647) || backoffMs > maxBackoffMs) throw new Error('Invalid scheduler options');
    this.completion = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.completion.catch(() => {});
  }
  start(): Promise<void> {
    if (!this.started && !this.stopping) {
      this.started = true;
      this.run = Promise.resolve().then(() => this.loop());
      void this.run.then(() => { this.finish(); }, () => { this.finish(); });
    }
    return this.completion;
  }
  private now(): number {
    const value = this.options.timers.now();
    if (!Number.isFinite(value) || value < 0 || (this.lastNow !== undefined && value < this.lastNow)) throw new Error('Invalid scheduler clock');
    this.lastNow = value;
    return value;
  }
  private async loop(): Promise<void> {
    const start = this.now();
    let attempts = 0;
    while (!this.stopping) {
      if (this.now() - start >= this.options.lifetimeMs) return;
      attempts++;
      await this.coordinator.tick();
      if (this.stopping || attempts >= this.options.maxAttempts || this.now() - start >= this.options.lifetimeMs) return;
      await new Promise<void>((wake) => {
        const id = this.options.timers.setTimeout(() => { this.timer = undefined; wake(); }, this.options.intervalMs);
        this.timer = {id, wake};
      });
    }
  }
  private finish(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      let timerError: unknown;
      let timerFailed = false;
      if (this.timer) {
        const timer = this.timer; this.timer = undefined;
        try { this.options.timers.clearTimeout(timer.id); } catch (error) { timerFailed = true; timerError = error; }
        timer.wake();
      }
      const stopped = Promise.resolve().then(() => this.coordinator.stop());
      void Promise.allSettled([this.run ?? Promise.resolve(), stopped]).then(([run, stop]) => {
        const errors: unknown[] = [];
        if (timerFailed) errors.push(timerError);
        if (run.status === 'rejected') errors.push(run.reason);
        if (stop.status === 'rejected') errors.push(stop.reason);
        if (errors.length === 0) this.resolve();
        else this.reject(errors.length === 1 ? errors[0] : new AggregateError(errors, 'Scheduler shutdown failed'));
      });
    }
    return this.completion;
  }
  stop(): Promise<void> { return this.finish(); }
}
