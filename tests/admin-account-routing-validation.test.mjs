import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real route handlers with registration and every dependency stubbed.
// No application initialization, database, authentication, or network is exercised.
function harness(initial = { id: 'fixture', name: 'legacy', priority: -1, weight: 0 }) {
  const routes = new Map();
  const router = { use() {}, post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
    patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers.at(-1)); }, get() {}, delete() {}, put() {} };
  let row = { ...initial }, writes = 0;
  class AccountRepository {
    create(data) { writes++; row = { id: 'fixture', ...data }; return row; }
    findByIdAdmin(id) { return id === row.id ? { ...row } : undefined; }
    update(id, data) { writes++; for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value; }
  }
  const modules = {
    express: { Router: () => router },
    '../auth/user-auth.js': { authenticateAdmin() {} },
    // Routes run inside an owned request-work scope (ADR 0009); admit synchronously here.
    '../request-work.js': { requestWork: { ownedDispatch(callback) { callback({ terminal() {}, run: fn => fn() }); return true; } } },
    '../db/repositories/users.js': { UserRepository: class {} },
    '../db/repositories/accounts.js': { AccountRepository },
    '../db/repositories/usage-logs.js': { UsageLogRepository: class {} },
    '../db/repositories/settings.js': { SettingsRepository: class {}, STRATEGIES: [] },
    '../utils/encryption.js': {}, '../utils/logger.js': { logger: { info() {}, error() {} } },
    '../upstream/oauth.js': { setOnLoginComplete() {} },
    '../upstream/siwc-login.js': { createSiwcRouter() { return {}; } },
    './routing-snapshot.js': {},
  };
  const source = readFileSync(new URL('../src/routes/admin.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require(name) { if (!Object.hasOwn(modules, name)) throw Error(`Unexpected import ${name}`); return modules[name]; } });
  function request(method, body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, set() { return this; } };
    routes.get(method === 'POST' ? 'POST /accounts' : 'PATCH /accounts/:id')({ body, params: { id: 'fixture' } }, res);
    return res;
  }
  return { request, get writes() { return writes; }, get row() { return row; } };
}
const required = { name: 'fixture', provider: 'openai', credentialType: 'api_key', credentials: 'synthetic' };

test('ordinary account writes reject invalid provided routing values without writing', () => {
  for (const method of ['POST', 'PATCH']) for (const [field, values] of Object.entries({
    priority: [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null],
    weight: [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null],
  })) for (const value of values) {
    const h = harness();
    const response = h.request(method, { ...(method === 'POST' ? required : {}), [field]: value });
    assert.equal(response.statusCode, 400, `${method} ${field}=${value}`);
    assert.equal(h.writes, 0, `${method} ${field}=${value} must not write`);
  }
});

test('defaults, large safe integers, and unrelated legacy updates remain accepted', () => {
  const h = harness();
  assert.equal(h.request('POST', required).statusCode, 201);
  assert.equal(h.row.priority, 0); assert.equal(h.row.weight, 1);
  const max = Number.MAX_SAFE_INTEGER;
  assert.equal(h.request('POST', { ...required, priority: max, weight: max }).statusCode, 201);
  assert.equal(h.row.priority, max); assert.equal(h.row.weight, max);
  assert.equal(h.request('PATCH', { priority: 0, weight: 100000000 }).statusCode, 200);
  assert.equal(h.row.priority, 0); assert.equal(h.row.weight, 100000000);
  const legacy = harness();
  assert.equal(legacy.request('PATCH', { name: 'renamed' }).statusCode, 200);
  assert.equal(legacy.row.priority, -1); assert.equal(legacy.row.weight, 0);
});
