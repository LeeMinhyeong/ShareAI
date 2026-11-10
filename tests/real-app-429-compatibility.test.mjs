import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupFixture } from './fixtures/real-app-429-cleanup.mjs';

test('close failure preserves fixture and both primary and cleanup errors', () => {
  const primary = new Error('primary');
  const closeError = new Error('close');
  let removed = false;
  let restored = false;
  assert.throws(() => cleanupFixture({
    close:() => { throw closeError; },
    restore:() => { restored = true; },
    remove:() => { removed = true; },
    dir:'synthetic-fixture', failed:true, primary,
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[1], closeError);
    assert.match(error.errors[2].message, /Fixture retained: synthetic-fixture/);
    return true;
  });
  assert.equal(restored, true);
  assert.equal(removed, false);
});

// Only the worker owns a database. It accepts no fixture data or database path.
// Snapshots cover main.sqlite_schema, main table rows, integrity/FK checks and journal mode,
// not database bytes, other schemas, or any production conversion.
test('real application schema produces a read-only indefinite legacy plan', () => {
  const worker = fileURLToPath(new URL('./fixtures/real-app-429-compatibility-worker.mjs', import.meta.url));
  // Deliberately pass conflicting ambient values, as a direct invocation might.
  const env = { PATH:process.env.PATH, SystemRoot:process.env.SystemRoot,
    NODE_ENV:'production', DATABASE_URL:'sqlite:unsafe-ambient.sqlite',
    ENCRYPTION_KEY:'invalid', ADMIN_API_KEY:'invalid', PORT:'invalid', LOG_LEVEL:'invalid',
    TMPDIR:'C:/Users/Administrator/AppData/Local/hermes/cache/scratch' };
  const child = spawnSync(process.execPath, ['--import', 'tsx', worker], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, `fixture worker failed: ${child.error || child.stderr}`);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.after, result.before);
  assert.deepEqual(result.extractionCounts, { counted:4, iterated:4, planned:4 });
  assert.deepEqual(result.extractorCases, {
    valid:{counted:8, iterated:8, planned:8, ids:['Case','case','é界','x'.repeat(512)]},
    tooLong:true, invalidUtf8:true, malformedSchema:true, unsafeInteger:true,
    wrongType:true, tempConflict:true, trigger:true, embeddedNul:true, tooMany:true, longKind:true,
  });
  assert.ok(result.before.schema.some(o => o.type === 'table' && o.name === 'users'));
  for (const name of ['upstream_accounts', 'siwc_accounts', 'siwc_credentials', 'account_429_cooldowns', 'ordinary_account_attempts', 'siwc_account_attempts']) {
    assert.ok(result.before.schema.some(o => o.type === 'table' && o.name === name), name);
  }
  assert.deepEqual(result.cooldowns, [
    {kind:'siwc', account_id:'orphan-s', observed_at:1, until_at:2, revision:4},
    {kind:'siwc', account_id:'shared', observed_at:100, until_at:200, revision:2},
    {kind:'upstream', account_id:'orphan-u', observed_at:3, until_at:4, revision:3},
    {kind:'upstream', account_id:'shared', observed_at:1000, until_at:4102444800000, revision:1},
  ]);
  assert.deepEqual(result.proposals, [
    {kind:'siwc', account_id:'orphan-s', generation:1, duration_ns:null},
    {kind:'siwc', account_id:'shared', generation:2, duration_ns:null},
    {kind:'upstream', account_id:'orphan-u', generation:3, duration_ns:null},
    {kind:'upstream', account_id:'shared', generation:4, duration_ns:null},
  ]);
  assert.deepEqual(result.before.rows.ordinary_account_attempts, [{account_id:'shared', attempt_id:'ordinary-open'}]);
  assert.deepEqual(result.before.rows.siwc_account_attempts, [{account_id:'shared', attempt_id:'siwc-open'}]);
  assert.deepEqual(result.before.rows.account_429_cooldowns, result.cooldowns);
  assert.deepEqual(result.before.rows.siwc_accounts, [{id:'shared',name:'synthetic siwc'}]);
  const upstream = result.before.rows.upstream_accounts[0];
  assert.deepEqual([upstream.id,upstream.name,upstream.provider,upstream.credential_type,upstream.credentials,upstream.status,upstream.quota_reset_at], ['shared','synthetic upstream','openai','api_key','synthetic-credential','active','2099-01-01']);
  const credential = result.before.rows.siwc_credentials[0];
  assert.equal(credential.id, 'shared');
  assert.equal(credential.revision, 'synthetic-revision');
  assert.equal(JSON.parse(credential.credentials).subject, 'synthetic-subject');
  assert.equal(result.before.integrity, 'ok');
  assert.deepEqual(result.before.foreignKeys, []);
});

test('worker rejects an untrusted scratch root before application initialization', () => {
  const worker = fileURLToPath(new URL('./fixtures/real-app-429-compatibility-worker.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--import', 'tsx', worker], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: process.cwd() },
    encoding:'utf8', timeout:30000,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /TMPDIR is not the trusted fixture scratch root/);
});
