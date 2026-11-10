import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';

function loadStore() {
  const source = readFileSync(new URL('../src/db/account-429-v2-store.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = vm.createContext({ exports, module: { exports }, require: (name) => { throw new Error(`Unexpected dependency: ${name}`); }, process: Object.freeze({ env: Object.freeze({}) }) });
  new vm.Script(code, { filename: 'account-429-v2-store.js' }).runInContext(context);
  return context.module.exports;
}

test('fresh provision and atomic arm', () => {
  const { provision429V2, arm429V2 } = loadStore();
  const db = new Database(':memory:');
  try {
    db.transaction(() => provision429V2(db))();
    db.transaction(() => arm429V2(db, 'upstream', 'a', 500))();
    const row = db.prepare('SELECT generation, duration_ms FROM main.account_429_v2_restrictions').safeIntegers().get();
    assert.deepEqual(row, { generation: 1n, duration_ms: 500n });
  } finally { db.close(); }
});

function fixture(fn) {
  const store = loadStore();
  const db = new Database(':memory:');
  try { fn(db, store); } finally { db.close(); }
}
function init(db, store) { db.transaction(() => store.provision429V2(db)).immediate(); }
function arm(db, store, kind, id, duration) { db.transaction(() => store.arm429V2(db, kind, id, duration)).immediate(); }
function row(db, kind, id) { return db.prepare('SELECT generation, duration_ms FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?').safeIntegers().get(kind, id); }
function count(db) { return db.prepare('SELECT generation FROM main.account_429_v2_counter').safeIntegers().get().generation; }

test('transaction and initialized schema are required', () => fixture((db, s) => {
  assert.throws(() => s.provision429V2(db), /transaction/);
  assert.throws(() => s.arm429V2(db, 'upstream', 'a', 1), /transaction/);
  assert.throws(() => db.transaction(() => s.arm429V2(db, 'upstream', 'a', 1))(), /schema/);
  init(db, s);
  assert.throws(() => s.arm429V2(db, 'upstream', 'a', 1), /transaction/);
}));

test('rearms retain maximum full duration and always increment', () => fixture((db, s) => {
  init(db, s);
  arm(db, s, 'upstream', 'same', 100);
  arm(db, s, 'upstream', 'same', 100);
  assert.deepEqual(row(db, 'upstream', 'same'), { generation: 2n, duration_ms: 100n });
  arm(db, s, 'upstream', 'same', 20);
  assert.deepEqual(row(db, 'upstream', 'same'), { generation: 3n, duration_ms: 100n });
  arm(db, s, 'upstream', 'same', 200);
  assert.deepEqual(row(db, 'upstream', 'same'), { generation: 4n, duration_ms: 200n });
}));

test('unknown duration is monotonic in both orders', () => fixture((db, s) => {
  init(db, s);
  arm(db, s, 'upstream', 'a', 25); arm(db, s, 'upstream', 'a', null); arm(db, s, 'upstream', 'a', 50);
  arm(db, s, 'upstream', 'b', null); arm(db, s, 'upstream', 'b', 50);
  assert.equal(row(db, 'upstream', 'a').duration_ms, null);
  assert.equal(row(db, 'upstream', 'b').duration_ms, null);
}));

test('namespace and full account ID stay distinct; removal never resets generation', () => fixture((db, s) => {
  init(db, s);
  arm(db, s, 'upstream', 'a', 1); arm(db, s, 'siwc', 'a', 2); arm(db, s, 'upstream', 'a ', 3);
  assert.deepEqual(row(db, 'siwc', 'a'), { generation: 2n, duration_ms: 2n });
  assert.deepEqual(row(db, 'upstream', 'a '), { generation: 3n, duration_ms: 3n });
  db.prepare('DELETE FROM main.account_429_v2_restrictions WHERE kind=? AND account_id=?').run('upstream', 'a');
  arm(db, s, 'upstream', 'a', 4);
  assert.deepEqual(row(db, 'upstream', 'a'), { generation: 4n, duration_ms: 4n });
}));

test('round-trippable SQLite text IDs remain distinct and can rearm', () => fixture((db, s) => {
  init(db, s);
  const ids = ['', '\u0000', '\u0000x', 'a\u0000b', 'a\u0000c', '\u0001\u0085', '😀한', '界'.repeat(2000)];
  for (const [i, id] of ids.entries()) {
    arm(db, s, 'upstream', id, i);
    const found = db.prepare('SELECT account_id, typeof(account_id) AS storage FROM account_429_v2_restrictions WHERE kind=? AND account_id=?').get('upstream', id);
    assert.ok(found && found.account_id === id && found.storage === 'text', 'exact bound text must round-trip');
  }
  for (const [i, id] of ids.entries()) {
    assert.equal(row(db, 'upstream', id).duration_ms, BigInt(i));
    arm(db, s, 'upstream', id, i + 100);
    assert.equal(row(db, 'upstream', id).duration_ms, BigInt(i + 100));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM account_429_v2_restrictions').get().n, ids.length);
}));

for (const operation of ['schema', 'arm']) test(`malformed UTF-8 collision is rejected before ${operation} mutation`, () => fixture((db, s) => {
  init(db, s);
  db.exec("UPDATE main.account_429_v2_counter SET generation=2; INSERT INTO main.account_429_v2_restrictions (rowid, kind, account_id, generation, duration_ms) VALUES (9007199254740993, 'upstream', CAST(X'FF' AS TEXT), 1, 50), (9007199254740994, 'upstream', '�', 2, 50)");
  const snapshot = () => ({
    counter: count(db),
    rows: db.prepare('SELECT rowid, hex(CAST(account_id AS BLOB)) AS bytes, generation, duration_ms FROM main.account_429_v2_restrictions ORDER BY rowid').safeIntegers().all(),
    count: db.prepare('SELECT count(*) AS n FROM main.account_429_v2_restrictions').get().n,
  });
  const before = snapshot();
  assert.deepEqual(before.rows.map(r => r.bytes), ['FF', 'EFBFBD']);
  assert.equal(before.count, 2);
  db.transaction(() => {
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    assert.throws(() => operation === 'schema' ? s.assert429V2Schema(db) : s.arm429V2(db, 'upstream', 'unrelated', 1), /Unsafe 429 v2 restriction/);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(snapshot(), before);
  }).immediate();
  assert.deepEqual(snapshot(), before);
}));

test('valid replacement character alone is accepted', () => fixture((db, s) => {
  init(db, s);
  arm(db, s, 'upstream', '�', 50);
  assert.equal(s.assert429V2Schema(db), 1n);
  arm(db, s, 'upstream', '�', 60);
  assert.deepEqual(row(db, 'upstream', '�'), { generation: 2n, duration_ms: 60n });
}));

test('ordinary SQLite TEXT primary key permits NULL but arm rejects it', () => fixture((db, s) => {
  db.exec('CREATE TABLE fixture_accounts (id TEXT PRIMARY KEY); INSERT INTO fixture_accounts VALUES (NULL), (NULL)');
  assert.equal(db.prepare('SELECT count(*) AS n FROM fixture_accounts WHERE id IS NULL').get().n, 2);
  init(db, s);
  assert.throws(() => arm(db, s, 'upstream', null, 1), /Invalid 429 v2 account id/);
  assert.equal(count(db), 0n);
}));

test('input and exact integer boundaries fail closed', () => fixture((db, s) => {
  init(db, s);
  for (const [kind, id, duration] of [['other', 'a', 1], ['siwc', '\ud800', 1], ['siwc', '\udc00', 1], ['siwc', 'a', -1], ['siwc', 'a', 0.5], ['siwc', 'a', NaN], ['siwc', 'a', Infinity], ['siwc', 'a', Number.MAX_SAFE_INTEGER + 1], ['siwc', 'a', 9007199254740992n], ['siwc', 'a', -1n], ['siwc', 'a', '1']]) {
    assert.throws(() => arm(db, s, kind, id, duration));
  }
  assert.equal(count(db), 0n);
  arm(db, s, 'siwc', 'a', 9007199254740991n);
  assert.equal(row(db, 'siwc', 'a').duration_ms, 9007199254740991n);
  db.prepare('UPDATE main.account_429_v2_counter SET generation=?').run(9223372036854775806n);
  arm(db, s, 'siwc', 'b', Number.MAX_SAFE_INTEGER);
  assert.equal(row(db, 'siwc', 'b').generation, 9223372036854775807n);
  assert.throws(() => arm(db, s, 'siwc', 'c', 0), /exhausted/);
  assert.equal(count(db), 9223372036854775807n);
  assert.equal(row(db, 'siwc', 'c'), undefined);
}));

test('caller failure after arm and OPEN deletion rolls back both', () => fixture((db, s) => {
  init(db, s);
  db.exec('CREATE TABLE fixture_open (id TEXT PRIMARY KEY); INSERT INTO fixture_open VALUES (\'owned\')');
  assert.throws(() => db.transaction(() => {
    s.arm429V2(db, 'upstream', 'a', 99);
    assert.equal(count(db), 1n);
    assert.deepEqual(row(db, 'upstream', 'a'), { generation: 1n, duration_ms: 99n });
    assert.equal(db.prepare('DELETE FROM fixture_open WHERE id=?').run('owned').changes, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fixture_open').get().n, 0);
    throw new Error('injected caller failure');
  }).immediate(), /injected caller failure/);
  assert.equal(count(db), 0n); assert.equal(row(db, 'upstream', 'a'), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fixture_open').get().n, 1);
}));

test('global generation corruption is rejected before unrelated rearm', () => {
  for (const corrupt of [
    db => db.prepare('UPDATE account_429_v2_counter SET generation=1').run(),
    db => db.prepare("UPDATE account_429_v2_restrictions SET generation=1 WHERE kind='siwc'").run(),
  ]) fixture((db, s) => {
    init(db, s); arm(db, s, 'upstream', 'same', 1); arm(db, s, 'siwc', 'same', 2);
    corrupt(db);
    const before = db.prepare('SELECT * FROM account_429_v2_restrictions ORDER BY kind').safeIntegers().all();
    const previous = count(db);
    assert.throws(() => arm(db, s, 'upstream', 'same', 10), /Unsafe 429 v2/);
    assert.deepEqual(db.prepare('SELECT * FROM account_429_v2_restrictions ORDER BY kind').safeIntegers().all(), before);
    assert.equal(count(db), previous);
  });
});

test('stored invalid rows are rejected and valid emoji accepted', () => {
  fixture((db, s) => { init(db, s); arm(db, s, 'upstream', '😀', 1); assert.equal(row(db, 'upstream', '😀').generation, 1n); });
  for (const sql of [
    "UPDATE account_429_v2_restrictions SET kind='other'",

    "UPDATE account_429_v2_restrictions SET account_id=CAST(x'eda080' AS TEXT)",
    'UPDATE account_429_v2_restrictions SET generation=0',
    'UPDATE account_429_v2_restrictions SET duration_ms=9007199254740992',
  ]) fixture((db, s) => {
    init(db, s); arm(db, s, 'siwc', 'bad', 1);
    db.pragma('ignore_check_constraints = ON'); db.exec(sql); db.pragma('ignore_check_constraints = OFF');
    assert.throws(() => arm(db, s, 'upstream', 'unrelated', 1), /Unsafe 429 v2/);
    assert.equal(count(db), 1n);
  });
});

test('canonical schema rejects extra indexes and incoming foreign keys', () => {
  fixture((db, s) => { init(db, s); assert.equal(s.assert429V2Schema(db), 0n); });
  for (const sql of [
    'CREATE INDEX extra_idx ON account_429_v2_restrictions(generation)',
    'CREATE TABLE incoming (id INTEGER REFERENCES account_429_v2_counter(id) ON DELETE CASCADE)',
    'CREATE TEMP TABLE incoming (id INTEGER REFERENCES account_429_v2_counter(id) ON DELETE CASCADE)',
  ]) fixture((db, s) => {
    init(db, s); db.exec(sql);
    assert.throws(() => db.transaction(() => s.assert429V2Schema(db)).immediate(), /Unsafe 429 v2/);
    assert.throws(() => arm(db, s, 'upstream', 'a', 1), /Unsafe 429 v2/);
    assert.equal(count(db), 0n);
  });
});

test('write failure after counter increment rolls back', () => fixture((db, s) => {
  init(db, s);
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => {
      if (sql.startsWith('INSERT INTO main.account_429_v2_restrictions')) {
        assert.equal(count(db), 1n);
        throw new Error('injected write failure');
      }
      return target.prepare(sql);
    };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => db.transaction(() => s.arm429V2(proxy, 'upstream', 'a', 1))(), /injected write failure/);
  assert.equal(count(db), 0n); assert.equal(row(db, 'upstream', 'a'), undefined);
}));

test('provision rejects existing or temporary conflicting objects without changes', () => {
  for (const ddl of ['CREATE TABLE account_429_v2_counter (x)', 'CREATE TABLE unrelated (x); CREATE INDEX account_429_v2_restrictions ON unrelated(x)', 'CREATE TEMP TABLE account_429_v2_schema_marker (x)', 'CREATE TEMP TABLE account_429_v2_counter (x)', 'CREATE TEMP TABLE account_429_v2_restrictions (x)']) fixture((db, s) => {
    db.exec(ddl);
    assert.throws(() => db.transaction(() => s.provision429V2(db))(), /schema/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name='account_429_v2_schema_marker'").get().n, 0);
  });
});

test('fresh provision is atomic on injected failure', () => fixture((db, s) => {
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => {
      if (sql.startsWith('INSERT INTO main.account_429_v2_counter')) throw new Error('injected provision failure');
      return target.prepare(sql);
    };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => db.transaction(() => s.provision429V2(proxy))(), /injected provision failure/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE name LIKE 'account_429_v2_%'").get().n, 0);
  init(db, s); assert.equal(count(db), 0n);
}));

test('marker corruption, duplicate markers, partial schema and TEMP shadow fail closed', () => {
  for (const mutate of [
    db => db.exec('DELETE FROM main.account_429_v2_schema_marker'),
    db => db.exec('DROP TABLE main.account_429_v2_schema_marker; CREATE TABLE account_429_v2_schema_marker (id INTEGER, version INTEGER); INSERT INTO account_429_v2_schema_marker VALUES (1,2),(1,2)'),
    db => db.exec('DROP TABLE main.account_429_v2_counter'),
    db => db.exec('CREATE TEMP TABLE account_429_v2_restrictions (x)'),
    db => db.exec('CREATE TRIGGER hostile AFTER INSERT ON account_429_v2_restrictions BEGIN SELECT 1; END'),
  ]) fixture((db, s) => {
    init(db, s); mutate(db);
    assert.throws(() => arm(db, s, 'upstream', 'a', 1), /schema/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM main.account_429_v2_restrictions').get().n, 0);
  });
});
