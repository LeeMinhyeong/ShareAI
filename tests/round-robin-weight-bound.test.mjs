import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// A separate, owned process subjects even a synchronous allocation to a hard deadline.
// Neither application configuration nor a real database is loaded.
async function exerciseManager() {
  const accounts = ['a', 'b'].map(id => ({
    id, provider: 'anthropic', status: 'active', credentialType: 'api_key',
    priority: 0, usedToday: 0, dailyQuota: 0, stateRevision: 0, weight: 1,
  }));
  class AccountRepository {
    findActiveByProvider(provider) {
      assert.equal(provider, 'anthropic');
      return accounts;
    }
  }
  const db = {
    prepare(sql) {
      assert.ok([
        "SELECT 1 FROM account_429_cooldowns WHERE kind='upstream' AND account_id=? AND until_at>?",
        'SELECT 1 FROM main.ordinary_account_attempts WHERE account_id=?',
        'SELECT day, used, legacy_ambiguous FROM account_daily_reservations WHERE account_id=?',
        // ADR 0019 item 8: selection reads the restriction's duration to explain an empty pool.
        'SELECT duration_ms FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?',
      ].includes(sql), `Unexpected query: ${sql}`);
      return { get: () => undefined };
    },
  };
  const unexpected = () => { throw new Error('Unexpected dependency call'); };
  const dependencies = {
    '../db/repositories/accounts.js': { AccountRepository },
    '../db/client.js': { getDb: () => db },
    '../db/async-writer.js': { withAsyncWriter: unexpected },
    '../utils/logger.js': { logger: { warn: unexpected, info: unexpected } },
    '../utils/encryption.js': { CredentialVault: class {} },
    '../upstream/siwc-store.js': { SiwcStore: class {} },
    '../upstream/oauth.js': { decodeJwt: unexpected, parseStoredCredentials: unexpected },
    '../db/usage-utc.js': { parseUsageUtc: unexpected },
    // No v2 restriction is active here; the real schema check needs a real database.
    '../db/account-429-v2-store.js': { assert429V2Schema() {} },
  };
  const source = await readFile(new URL('../src/account-pool/manager.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(javascript, { context });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected import: ${specifier}`);
    const exports = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const { AccountPoolManager } = module.namespace;
  const select = async pool => (await pool.selectCandidate('user', 'model', 'anthropic', 'round_robin'))?.id;
  const key = JSON.stringify(['anthropic', ['a', 'b']]);

  accounts[0].weight = 2;
  let pool = new AccountPoolManager();
  const sequence = [];
  for (let i = 0; i < 6; i++) sequence.push(await select(pool));
  assert.deepEqual(sequence, ['a', 'a', 'b', 'a', 'a', 'b']);

  accounts[0].weight = 1_000_000_000;
  pool = new AccountPoolManager();
  assert.equal(await select(pool), 'a');
  pool.roundRobinCounters.set(key, 999_999_999n);
  assert.equal(await select(pool), 'a');
  assert.equal(pool.roundRobinCounters.get(key), 1_000_000_000n);
  assert.equal(await select(pool), 'b');
  assert.equal(pool.roundRobinCounters.get(key), 0n);
  assert.equal(await select(pool), 'a');
  assert.equal(pool.roundRobinCounters.get(key), 1n);

  // Exercise modulo beyond Number's exact integer range without a billion picks.
  const largeCounter = 9_007_199_254_740_993n;
  const total = 1_000_000_001n;
  pool.roundRobinCounters.set(key, largeCounter);
  const position = largeCounter % total;
  assert.equal(await select(pool), position < 1_000_000_000n ? 'a' : 'b');
  const next = pool.roundRobinCounters.get(key);
  assert.equal(typeof next, 'bigint');
  assert.equal(next, (position + 1n) % total);
  assert.ok(next >= 0n && next < total);
}

async function waitForOwnedChild(child, deadlineMs = 10_000, reapMs = 2_000) {
  return new Promise((resolve, reject) => {
    const failures = [];
    let killAttempted = false;
    let closed = false;
    let finished = false;
    let reapTimer;
    const deadlineTimer = setTimeout(() => {
      failures.push(new Error('owned selection child exceeded its deadline'));
      attemptKill();
    }, deadlineMs);

    function finish(unconfirmed = false) {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(reapTimer);
      if (unconfirmed) {
        failures.push(new Error(`owned selection child pid ${child.pid ?? 'unknown'} close unconfirmed after kill; OS may have refused termination`));
        // A denied kill cannot be guaranteed. Do not hold the parent open forever.
        child.unref?.();
      }
      if (failures.length) {
        reject(new AggregateError(failures, failures.map(error => error.message).join('; ')));
      } else {
        resolve();
      }
    }
    function attemptKill() {
      if (killAttempted || closed) return;
      killAttempted = true;
      clearTimeout(deadlineTimer);
      reapTimer = setTimeout(() => finish(true), reapMs);
      try {
        if (!child.kill('SIGKILL')) failures.push(new Error('owned selection child kill returned false'));
      } catch (error) {
        failures.push(new Error('owned selection child kill threw', { cause: error }));
      }
    }
    function onError(error) {
      failures.push(error instanceof Error ? error : new Error('owned selection child emitted an error', { cause: error }));
      attemptKill();
    }
    child.on('error', onError);
    child.once('close', (code, signal) => {
      closed = true;
      // Keep the error guard until close even if the bounded wait already expired.
      child.removeListener('error', onError);
      queueMicrotask(() => {
        if (signal !== null && !killAttempted) failures.push(new Error('owned selection child terminated by signal'));
        if (code !== 0 && !killAttempted) failures.push(new Error('owned selection child failed'));
        finish();
      });
    });
  });
}

function assertDeadlineOnly(error) {
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors.map(item => item.message), [
    'owned selection child exceeded its deadline',
  ]);
  return true;
}

if (process.argv[2] === '--weight-child') {
  await exerciseManager();
} else {
  test('weighted round robin preserves large weights without materializing slots', async () => {
    const child = spawn(process.execPath, [
      '--experimental-vm-modules', fileURLToPath(import.meta.url), '--weight-child',
    ], {
      env: { SystemRoot: process.env.SystemRoot ?? '', NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await waitForOwnedChild(child);
  });

  test('a kill error does not settle before owned child close', async () => {
    const child = new EventEmitter();
    child.kill = () => {
      setImmediate(() => child.emit('error', new Error('simulated kill error')));
      return true;
    };
    let settled = false;
    const result = waitForOwnedChild(child, 5).catch(error => { settled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 30));
    const settledBeforeClose = settled;
    child.emit('close', null, 'SIGKILL');
    const error = await result;
    assert.equal(settledBeforeClose, false);
    assert.match(error.message, /simulated kill error/);
  });

  test('false kill result waits for close and reports the failure', async () => {
    const child = new EventEmitter();
    let killed = 0;
    child.kill = signal => { assert.equal(signal, 'SIGKILL'); killed++; return false; };
    let settled = false;
    const result = waitForOwnedChild(child, 5, 500).catch(error => { settled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 25));
    const settledBeforeClose = settled;
    child.emit('close', 0, null);
    const error = await result;
    assert.equal(settledBeforeClose, false);
    assert.equal(killed, 1);
    assert.match(error.message, /kill returned false/);
    assert.match(error.message, /exceeded its deadline/);
    // Negative control: the real-child success predicate must reject this failure.
    assert.throws(() => assertDeadlineOnly(error), { code: 'ERR_ASSERTION' });
  });

  test('thrown kill error waits for close and is retained', async () => {
    const child = new EventEmitter();
    const failure = new Error('simulated thrown kill');
    child.kill = () => { throw failure; };
    const result = waitForOwnedChild(child, 5, 500).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 25));
    child.emit('close', null, 'SIGKILL');
    const error = await result;
    assert.ok(error.errors.some(item => item.cause === failure));
  });

  test('unconfirmed close is bounded, reported, and guarded against late errors', async () => {
    const child = new EventEmitter();
    child.pid = 12345;
    let unrefed = false;
    child.kill = () => false;
    child.unref = () => { unrefed = true; };
    const error = await waitForOwnedChild(child, 5, 20).catch(error => error);
    assert.match(error.message, /kill returned false/);
    assert.match(error.message, /pid 12345 close unconfirmed/);
    assert.equal(unrefed, true);
    child.emit('error', new Error('simulated late error'));
    child.emit('close', null, 'SIGKILL');
    assert.equal(child.listenerCount('error'), 0);
  });

  test('deadline kills and observes close of an owned child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { SystemRoot: process.env.SystemRoot ?? '' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    let close;
    child.once('close', (code, signal) => { close = { code, signal }; });
    await assert.rejects(waitForOwnedChild(child, 250), assertDeadlineOnly);
    assert.ok(close, 'child close must be observed');
    // Windows reported { code: null, signal: 'SIGKILL' } here, but its signal
    // value is not guaranteed; require abnormal termination, not that signal.
    assert.ok(close.code !== 0 && (close.code !== null || close.signal !== null),
      'child must not close successfully on its own');
  });
}
