import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Compile the actual production sources in a closed VM: no module loading,
// process environment, configuration, filesystem, or network capabilities.
let violations = 0;
const forbidden = () => { violations++; throw new Error('forbidden VM capability'); };
// Prove the traps fire before loading either production module.
test('VM capability traps fire', () => {
  const before = violations;
  try {
    const probe = vm.createContext({process:new Proxy({}, {get:forbidden}), require:forbidden, fetch:forbidden});
    for (const expression of ['process.env', "require('dotenv')", 'fetch()']) {
      assert.throws(() => new vm.Script(expression).runInContext(probe), /forbidden VM capability/);
    }
    assert.equal(violations - before, 3);
  } finally { violations = before; }
});
class FixtureDate extends Date { static now() { return clock; } }
let clock = Date.parse('2026-01-02T03:04:05.250Z');
function load(name: string) {
  const source = readFileSync(new URL(name, import.meta.url), 'utf8');
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) assert.ok(statement.importClause?.isTypeOnly, 'runtime imports forbidden');
    assert.ok(!ts.isExportDeclaration(statement) || !statement.moduleSpecifier, 'reexports forbidden');
  }
  const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, strict:true}, reportDiagnostics:true});
  assert.equal(compiled.diagnostics?.length, 0);
  const exports = {};
  const processTrap = new Proxy({}, {get:forbidden, set:forbidden});
  const context = vm.createContext({exports, process:processTrap, require:forbidden, fetch:forbidden, Date:FixtureDate, TextDecoder, AbortController});
  new vm.Script(compiled.outputText, {filename:name}).runInContext(context, {timeout:1000});
  return exports;
}
const { infer, UpstreamError } = load('./inference.ts') as typeof import('./inference.js');
const { ordinary429Deadline, recovery429Duration } = load('./ordinary-429-deadline.ts') as typeof import('./ordinary-429-deadline.js');
// Structural wiring checks are whitespace-tolerant; the parser's behavior is tested below.
test('router wiring uses the extracted parser', () => {
  const routerSource = readFileSync(new URL('./forward-chat.ts', import.meta.url), 'utf8');
  assert.match(routerSource, /import\s*\{[^}]*\bordinary429Deadline\b[^}]*\brecovery429Duration as recovery429DurationAt\b[^}]*\}\s*from\s*['"]\.\/ordinary-429-deadline\.js['"]/);
  // Persisted restrictions pass through the stricter recovery gate with a fresh wall-clock sample.
  assert.match(routerSource, /recovery429DurationAt\(Date\.now\(\),\s*hint,\s*serverDate\)/);
  assert.match(routerSource, /recovery429Duration\(restriction\.hint,\s*restriction\.date\)/);
  // ADR 0019: HTTP outcomes and in-stream provider failures share providerRestrictionMs.
  assert.match(routerSource, /status === 429\s*\?\s*recovery429Duration\(retryAfter,\s*date\)/);
  assert.match(routerSource, /providerRestrictionMs\(response\.status,\s*response\.headers\.get\('retry-after'\)/);
  // Client Retry-After header guidance uses the same parser.
  assert.match(routerSource, /status === 429[\s\S]{0,200}?ordinary429Deadline\(now,\s*error\.headers\['retry-after'\],\s*error\.headers\.date\)/);
});


// A synthetic response preserves raw invalid field strings; real Fetch implementations
// may reject or normalize them before this point. No network request is made.
async function deadline(hint: string, date?: string): Promise<number> {
  const entries = [['retry-after', hint], ...(date === undefined ? [] : [['date', date]])];
  const response = { ok: false, status: 429, headers: { entries: () => entries[Symbol.iterator]() }, body: null } as unknown as Response;
  try {
    await infer('openai', {kind:'api_key', token:'sk-fixture', canRefresh:false},
      {model:'fixture', messages:[{role:'user', content:'hello'}]}, undefined, undefined, async () => response);
    assert.fail('expected a 429');
  } catch (error) {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 429);
    return ordinary429Deadline(FixtureDate.now(), error.headers?.['retry-after'], error.headers?.date);
  }
}

test('complete 429 header values reject trailing line terminators', async () => {
  const original = clock;
  const now = Date.parse('2026-01-02T03:04:05.250Z');
  clock = now;
  try {
    for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
      for (const hint of ['60', 'Fri, 02 Jan 2026 03:06:05 GMT', 'Friday, 02-Jan-26 03:06:05 GMT', 'Fri Jan  2 03:06:05 2026']) {
        assert.equal(await deadline(hint + suffix), Number.MAX_SAFE_INTEGER, JSON.stringify(hint + suffix));
      }
    }
    assert.equal(await deadline('60'), now + 60000);
    assert.equal(await deadline('Fri, 02 Jan 2026 03:06:05 GMT'), Date.parse('2026-01-02T03:06:05Z'));
    assert.equal(await deadline('Fri, 02 Jan 2026 02:06:05 GMT', 'Fri, 02 Jan 2026 02:04:05 GMT'), now + 121000);
    assert.equal(await deadline('Fri, 02 Jan 2026 03:06:05 GMT', 'Fri, 02 Jan 2026 03:05:05 GMT'), Date.parse('2026-01-02T03:06:05Z'));
    assert.equal(await deadline('999999999999999999999999999999'), Number.MAX_SAFE_INTEGER);
    clock = Date.parse('2090-01-01T00:00:00Z');
    assert.equal(await deadline('Friday, 01-Jan-06 00:00:00 GMT'), Date.parse('2106-01-01T00:00:00Z'));
    clock = now;
    // A malformed Date is ignored; it must not supply the relative interval.
    assert.equal(await deadline('Fri, 02 Jan 2026 02:06:05 GMT', 'Fri, 02 Jan 2026 02:04:05 GMT\n'), now + 5000);
  } finally { clock = original; }
  assert.equal(clock, original);
  assert.equal(violations, 0, 'no environment, module or network access');
});

test('persisted recovery duration requires a trusted provider Date for absolute hints', () => {
  const now = Date.parse('2026-01-02T03:04:05.250Z');
  const absolute = 'Fri, 02 Jan 2026 02:06:05 GMT';
  // Numeric and absent hints never need a provider Date.
  assert.equal(recovery429Duration(now, undefined), 5000);
  assert.equal(recovery429Duration(now, '0'), 5000);
  assert.equal(recovery429Duration(now, '60'), 60000);
  // Trusted IMF-fixdate Date: provider-relative interval plus one second of precision.
  assert.equal(recovery429Duration(now, absolute, 'Fri, 02 Jan 2026 02:04:05 GMT'), 121000);
  // Absent, obsolete-format, malformed or out-of-range provider Dates are unknown.
  for (const date of [undefined, 'Friday, 02-Jan-26 02:04:05 GMT', 'Fri Jan  2 02:04:05 2026',
    'Fri, 02 Jan 2026 02:04:05 GMT\n', 'Thu, 02 Jan 2026 02:04:05 GMT',
    // Round-trips through toUTCString but lies below the parser's 1000-9999 bound.
    'Tue, 01 Jan 0999 00:00:00 GMT']) {
    assert.equal(recovery429Duration(now, absolute, date), null, JSON.stringify(date));
  }
  // Unrepresentable hints and invalid clocks are unknown, never a short wait.
  assert.equal(recovery429Duration(now, '9007199254740991'), null);
  assert.equal(recovery429Duration(now, 'not a date', 'Fri, 02 Jan 2026 02:04:05 GMT'), null);
  assert.equal(recovery429Duration(-1, '60'), null);
  assert.equal(recovery429Duration(Number.NaN, '60'), null);
  assert.equal(recovery429Duration(8640000000000001, '60'), null);
  assert.equal(recovery429Duration(0, '60'), 60000);
  // Absolute hints at or before the provider Date are finite: precision allowance or the 5s minimum.
  assert.equal(recovery429Duration(now, 'Fri, 02 Jan 2026 02:04:05 GMT', 'Fri, 02 Jan 2026 02:04:05 GMT'), 5000);
  assert.equal(recovery429Duration(now, 'Fri, 02 Jan 2026 02:04:04 GMT', 'Fri, 02 Jan 2026 02:04:05 GMT'), 5000);
});
