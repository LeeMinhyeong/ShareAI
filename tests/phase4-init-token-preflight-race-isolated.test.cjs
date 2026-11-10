'use strict';
// Isolated, simulated schema interleaving: no application configuration or file DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const SQLite = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const allowed = new Set(['src/db/client.ts', 'src/db/schema.ts']);
function source(relative) {
  assert(allowed.has(relative), 'source path not allowlisted');
  return fs.readFileSync(path.join(root, relative), 'utf8');
}
function load(relative, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(source(relative), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const localRequire = name => {
    assert(Object.hasOwn(dependencies, name), `import not allowlisted: ${name}`);
    return dependencies[name];
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: relative })(localRequire, module, module.exports);
  return module.exports;
}
const schema = load('src/db/schema.ts', {});
const owned = new SQLite(':memory:');
let simulateChange = false;
let injected = false;
const originalPragma = owned.pragma.bind(owned);
owned.pragma = function(statement, options) {
  const result = originalPragma(statement, options);
  if (simulateChange && statement === 'synchronous = FULL') {
    simulateChange = false;
    injected = true;
    owned.exec('DROP TABLE usage_logs');
  }
  return result;
};
function Database(name, options) {
  assert.equal(name, 'synthetic');
  assert.deepEqual(options, { timeout: 5000, fileMustExist: true });
  return owned;
}
const v2 = {
  provision429V2(db) { db.exec('CREATE TABLE fake_v2_marker (id INTEGER PRIMARY KEY); INSERT INTO fake_v2_marker VALUES (1)'); },
  assert429V2Schema(db) { assert.equal(db.prepare('SELECT id FROM fake_v2_marker').pluck().get(), 1); },
};
const client = load('src/db/client.ts', {
  'better-sqlite3': Database,
  '../config/env.js': { env: { DATABASE_URL: 'sqlite:synthetic' } },
  '../utils/logger.js': { logger: { info() {} } },
  './schema.js': schema,
  '../upstream/siwc-store.js': { SiwcStore: { initialize() {} } },
  './account-429-v2-store.js': v2,
});
try {
  owned.transaction(() => client.provisionFreshSafetySchema(owned)).immediate();
  owned.exec(schema.SQL_SCHEMA);
  simulateChange = true;
  assert.throws(() => client.initDatabase(), /Incompatible usage_logs schema/,
    'initializer must reject usage history removed after preflight rather than recreate it');
  assert.equal(injected, true, 'interleaving must be exercised');
  console.log('PASS: missing usage history rejected before transactional schema creation');
} finally {
  if (owned.open) owned.close();
}
