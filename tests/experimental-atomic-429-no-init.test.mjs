import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, realpathSync, existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = new URL('../src/db/experimental-atomic-429-app.ts', import.meta.url).href;
const secret = 'synthetic-test-secret-not-for-logs';
const script = `
  import assert from 'node:assert/strict';
  import {settleAppAttempt} from ${JSON.stringify(app)};
  const input={kind:'upstream',accountId:'synthetic-account',attemptId:'synthetic-attempt',durationNs:1n};
  await assert.rejects(settleAppAttempt(input), /initializ|closed/i);
  await assert.rejects(settleAppAttempt(input), /initializ|closed/i);
`;

test('uninitialized experimental settlement never creates its configured database or parent', () => {
  const scratch = realpathSync(process.env.TMPDIR);
  const root = mkdtempSync(join(scratch, 'atomic-no-init-'));
  const parent = join(root, 'not-created');
  const file = join(parent, 'synthetic.sqlite');
  try {
    const env = {SystemRoot:process.env.SystemRoot, PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch,
      NODE_ENV:'test', DATABASE_URL:`sqlite:${file}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:secret, LOG_LEVEL:'info', LOG_PRETTY:'false'};
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      {cwd:root, env, encoding:'utf8', timeout:15000});
    assert.ifError(result.error);
    assert.equal((result.stdout + result.stderr).includes(secret), false, 'synthetic secret leaked to logs');
    assert.equal((result.stdout + result.stderr).includes('a'.repeat(64)), false, 'synthetic encryption key leaked to logs');
    assert.equal(existsSync(file), false, 'experimental call created database file');
    assert.equal(existsSync(parent), false, 'experimental call created database directory');
    assert.deepEqual(readdirSync(root), [], 'experimental call created files');
    assert.equal(result.status, 0, `worker failed: ${result.stderr}`);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

// In-memory SQLite is unsupported (ADR 0018); only the file database is exercised.
for (const mode of ['file']) test(`initialized ${mode} database settles and fails closed after closure`, () => {
  const scratch = realpathSync(process.env.TMPDIR);
  const root = mkdtempSync(join(scratch,'atomic-lifecycle-'));
  try {
    const database = mode === 'memory' ? ':memory:' : join(root,'synthetic.sqlite');
    const env = {SystemRoot:process.env.SystemRoot, PATH:process.env.PATH, TMPDIR:scratch, TEMP:scratch, TMP:scratch,
      NODE_ENV:'test', DATABASE_URL:`sqlite:${database}`, ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:secret, LOG_LEVEL:'error', LOG_PRETTY:'false'};
    const worker = fileURLToPath(new URL('./experimental-atomic-429-lifecycle-worker.mjs',import.meta.url));
    const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),worker],{cwd:root,env,encoding:'utf8',timeout:15000});
    assert.ifError(result.error);
    assert.equal((result.stdout+result.stderr).includes(secret),false,'synthetic secret leaked to logs');
    assert.equal((result.stdout+result.stderr).includes('a'.repeat(64)),false,'synthetic encryption key leaked to logs');
    assert.equal(result.status,0,`worker failed: ${result.stderr}`);
  } finally {rmSync(root,{recursive:true,force:true});}
});
