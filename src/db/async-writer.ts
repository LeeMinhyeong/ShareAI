import Database from 'better-sqlite3';
import { getDb, requireInitializedDatabase } from './client.js';
import { logger } from '../utils/logger.js';

// Retain uncertain handles and refuse further writes until an explicit retry
// confirms closure. No timers: quarantine itself cannot keep the process alive.
const quarantined = new Set<Database.Database>();
const closing = new Set<Database.Database>();
let cleaning = false;
function releaseWriter(db: Database.Database): void {
  if (closing.has(db)) throw new Error('Writer close is already in progress');
  quarantined.add(db);
  closing.add(db);
  try {
  let failed = false, failure: unknown;
  try { if (db.open !== false) db.close(); } catch (error) { failed = true; failure = error; }
  try {
    if (db.open !== false) throw new Error('Writer close did not close connection');
    quarantined.delete(db);
  } catch (error) {
    if (failed) throw new AggregateError([failure, error], 'Writer close and verification failed');
    throw error;
  }
  if (failed) throw failure;
  } finally { closing.delete(db); }
}

/** Retry only cleanup, never the transaction or its callback. */
export function retryQuarantinedWriters(): void {
  if (cleaning) throw new Error('Writer quarantine cleanup is already in progress');
  cleaning = true;
  let failed = false;
  try {
    for (const db of quarantined) {
      try { releaseWriter(db); } catch { failed = true; }
    }
  } finally { cleaning = false; }
  if (failed) throw new Error('Writer quarantine cleanup failed');
}

/** A separate zero-wait writer. Only lock acquisition is retried; the callback
 * and commit run once, synchronously, so side effects are never repeated. */
export function withAsyncWriter<T>(operation: (db: Database.Database) => T, options: {signal?: AbortSignal; timeoutMs?: number} = {}): T | Promise<T> {
  const assertNoQuarantine = () => { if (quarantined.size || cleaning) throw new Error('Writer is quarantined'); };
  assertNoQuarantine();
  const shared = getDb();
  // A nested savepoint is not a durable commit; a separate file writer also
  // must not escape the caller's active transaction or its lock/state.
  const rejectOuterTransaction = () => {
    assertNoQuarantine();
    if (requireInitializedDatabase() !== shared) throw new Error('Database is not initialized or is closed');
    if (shared.inTransaction) throw new Error('Async writer cannot run inside an active transaction');
    if (requireInitializedDatabase() !== shared) throw new Error('Database is not initialized or is closed');
    assertNoQuarantine();
  };
  rejectOuterTransaction();
  const path = shared.name;
  assertNoQuarantine();
  // A private in-memory database cannot be opened by another process. Keep the
  // synchronous API for its existing unit-test and embedded callers.
  if (path === ':memory:') {
    options.signal?.throwIfAborted();
    rejectOuterTransaction();
    return shared.transaction(() => {
      options.signal?.throwIfAborted();
      if (requireInitializedDatabase() !== shared) throw new Error('Database is not initialized or is closed');
      const value = operation(shared);
      if (value instanceof Promise) throw new Error('Async writer callback must be synchronous');
      if (requireInitializedDatabase() !== shared) throw new Error('Database is not initialized or is closed');
      assertNoQuarantine();
      return value;
    }).immediate();
  }
  if (!path) throw new Error('Async writer requires a file-backed database');
  const db = new Database(path, {timeout: 0, fileMustExist: true});
  let closeAttempted = false;
  const close = () => { if (!closeAttempted) { closeAttempted = true; releaseWriter(db); } };
  const closeAfterFailure = (error: unknown): never => {
    try { close(); } catch {
      // Deliberately generic: a close failure may carry sensitive driver detail and must not leak
      // (tests/db-lifecycle-reentrancy-memory: "cleanup exceptions do not leak ...").
      throw new AggregateError([error, new Error('Writer cleanup failed')], 'Writer and cleanup failed');
    }
    throw error;
  };
  let deadline: number;
  try {
    assertNoQuarantine();
    db.pragma('foreign_keys = ON');
    // Refresh intents must be durable before a token can leave this process.
    db.pragma('synchronous = FULL');
    assertNoQuarantine();
    deadline = performance.now() + (options.timeoutMs ?? 5000);
  } catch (error) {
    return closeAfterFailure(error);
  }
  const attempt = (): T | Promise<T> => {
    try {
      rejectOuterTransaction();
      options.signal?.throwIfAborted();
      rejectOuterTransaction();
      try { db.exec('BEGIN IMMEDIATE'); }
      catch (error: any) {
        if (error?.code !== 'SQLITE_BUSY' && error?.code !== 'SQLITE_LOCKED') throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        return new Promise<void>((resolve, reject) => {
          const signal = options.signal;
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.min(20, remaining));
          const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal?.reason); };
          signal?.addEventListener('abort', onAbort, {once: true});
          if (signal?.aborted) onAbort();
        }).then(() => { if (performance.now() >= deadline) throw error; return attempt(); }).catch(closeAfterFailure);
      }
      try {
        options.signal?.throwIfAborted();
        if (requireInitializedDatabase() !== shared) throw new Error('Database is not initialized or is closed');
        const value = operation(db);
        if (value instanceof Promise) throw new Error('Async writer callback must be synchronous');
        if (requireInitializedDatabase() !== shared) throw new Error('Database is not initialized or is closed');
        assertNoQuarantine();
        // A thrown COMMIT has no reliable acknowledgement, even when a
        // subsequent rollback succeeds. Never expose it as a retryable domain error.
        try { db.exec('COMMIT'); }
        catch { throw new Error('Writer commit outcome is unknown'); }
        return value;
      } catch (error) {
        try { if (db.inTransaction) db.exec('ROLLBACK'); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Writer and rollback failed'); }
        throw error;
      }
    } catch (error) { return closeAfterFailure(error); }
  };
  // A returned COMMIT establishes success. Cleanup cannot turn that result into
  // a transaction failure; retain any unconfirmed handle in quarantine instead.
  const closeAfterCommit = (value: T): T => {
    try { close(); }
    catch {
      // A logger failure must not change a confirmed transaction outcome.
      try { logger.error('Committed writer cleanup failed'); } catch { /* best effort */ }
    }
    return value;
  };
  const result = attempt();
  if (result instanceof Promise) return result.then(closeAfterCommit);
  return closeAfterCommit(result);
}
