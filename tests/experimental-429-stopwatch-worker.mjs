import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { arm, Stopwatch } from '../src/db/experimental-429-stopwatch.ts';
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 0');
let now = 9007199254740993000n;
let trace = null;
let gateFile = null;
let writerGateFile = null;
function waitGate(file) {
  const until = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error('barrier timeout');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
}
const watch = new Stopwatch(db, () => { if (trace) trace.push({event:'clock', inTransaction:db.inTransaction}); return now; });
const originalPrepare = db.prepare.bind(db);
db.prepare = function(sql) {
  const stmt = originalPrepare(sql);
  if (sql.startsWith('SELECT generation,duration')) {
    return new Proxy(stmt, { get(target, prop) {
      if (prop === 'get') return (...args) => {
        const row = target.get(...args);
        if (trace) trace.push({event:'read', inTransaction:db.inTransaction, row:row ?? null});
        if (gateFile && !db.inTransaction) {
          const file = gateFile; gateFile = null;
          process.send({event:'selected', row});
          waitGate(file);
        }
        return row;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  return stmt;
};
// Observe the actual transaction's immediate() call; never substitute a lock probe.
const originalTransaction = db.transaction.bind(db);
db.transaction = function(fn) {
  const transaction = originalTransaction(fn);
  return { immediate(...args) {
    if (trace) trace.push({event:'beforeImmediate'});
    if (writerGateFile) {
      const file = writerGateFile; writerGateFile = null;
      process.send({event:'beforeWriter'});
      waitGate(file);
    }
    try {
      const value = transaction.immediate(...args);
      if (trace) trace.push({event:'committed'});
      return value;
    } catch (e) {
      if (trace) trace.push({event:'error', code:e.code, inTransaction:db.inTransaction});
      if (e.code === 'SQLITE_BUSY') process.send({event:'writerBusy', trace});
      throw e;
    }
  } };
};
process.on('message', (msg) => {
  trace = msg.trace ? [] : null;
  try {
    let value;
    switch (msg.cmd) {
      case 'now': now = BigInt(msg.value); break;
      case 'arm': writerGateFile = msg.writerGateFile || null; value = arm(db, msg.kind, msg.id, msg.duration); break;
      case 'check': gateFile = msg.gateFile || null; value = watch.check(msg.kind,msg.id); break;
      case 'hold': db.exec('BEGIN IMMEDIATE'); break;
      case 'holdRearm': {
        db.exec('BEGIN IMMEDIATE');
        const gen = randomUUID();
        db.prepare('INSERT INTO experimental_429_generations VALUES (?)').run(gen);
        db.prepare('UPDATE experimental_429_restrictions SET generation=?,duration=? WHERE kind=? AND account_id=?').run(gen,msg.duration,msg.kind,msg.id);
        value = gen;
        break;
      }
      case 'commit': db.exec('COMMIT'); break;
      case 'close': db.close(); process.send({ id: msg.requestId, value: null }, () => process.exit(0)); return;
      default: throw new Error('bad command');
    }
    process.send({ id: msg.requestId, value: value ?? null, trace });
  } catch (e) { process.send({ id: msg.requestId, error: String(e.stack || e), code:e.code, trace }); }
});
process.send({ event: 'ready' });