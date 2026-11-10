import {waitForChild} from './async-writer-startup-cases.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, realpathSync} from 'node:fs';
import {join, parse, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

function checkedScratch() {
  const root = resolve(userInfo().homedir, 'AppData', 'Local', 'hermes', 'cache', 'scratch');
  let p = parse(root).root;
  for (const segment of root.slice(p.length).split(/[\\/]/).filter(Boolean)) {
    p = join(p, segment);
    assert.equal(lstatSync(p).isSymbolicLink(), false);
    assert.equal(realpathSync(p).toLowerCase(), p.toLowerCase());
  }
  return root;
}

test('inherited child selector refuses rogue database before import', async () => {
  const root = checkedScratch();
  const dir = mkdtempSync(join(root, 'writer-rogue-'));
  const owned = mkdtempSync(join(root, 'writer-startup-'));
  const sentinel = join(dir, 'sentinel.sqlite');
  const evil = join(dir, 'evil.sqlite');
  let preserve = false;
  try {
    writeFileSync(sentinel, 'synthetic sentinel', {mode: 0o444});
    const hash = () => createHash('sha256').update(readFileSync(sentinel)).digest('hex');
    const before = hash();
    for (const target of [sentinel, evil]) {
      const env = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TMPDIR: owned, TEMP: owned, TMP: owned, NODE_ENV: 'test', WRITER_TEST_CASE: 'file-success',
        DATABASE_URL: `sqlite:${target}`, ENCRYPTION_KEY: '0'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_LEVEL: 'error'};
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./async-writer-startup-cases.mjs', import.meta.url))],
        {cwd: owned, env, stdio: ['ignore', 'ignore', 'pipe']});
      let stderr = '';
      child.on('error', () => {});
      child.stderr.on('error', () => {});
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 8192); });
      const result = await waitForChild(child, {deadline: 15000, grace: 5000});
      if (!result.closed) preserve = true;
      assert.ok(result.closed, `child close unconfirmed; pid=${result.pid}; fixtures preserved: ${owned}, ${dir}`);
      assert.match(stderr, /unsafe writer fixture/);
      assert.notEqual(result.code, 0);
      assert.equal(existsSync(evil), false);
      assert.equal(hash(), before);
    }
  } finally { if (!preserve) { rmSync(owned, {recursive: true, force: true}); rmSync(dir, {recursive: true, force: true}); } }
});

test('failed kill is bounded and reports the unconfirmed child', async () => {
  for (const behavior of ['false', 'throws']) {
    const fake = new EventEmitter();
    fake.pid = 12345;
    fake.kill = () => { if (behavior === 'throws') throw new Error('fake'); return false; };
    let unref = false, destroy = false;
    fake.unref = () => { unref = true; };
    fake.stderr = {destroy: () => { destroy = true; }};
    const result = await waitForChild(fake, {deadline: 1, grace: 5});
    assert.deepEqual(result, {closed: false, pid: 12345, killError: behavior === 'throws' ? 'kill threw' : 'kill returned false'});
    assert.ok(unref && destroy);
  }
});

test('real owned child termination confirms close', async () => {
  const root = checkedScratch();
  const dir = mkdtempSync(join(root, 'writer-startup-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: dir, env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: dir, TMP: dir, TEMP: dir},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stderr.resume();
  const result = await waitForChild(child, {deadline: 200, grace: 5000});
  if (result.closed) rmSync(dir, {recursive: true, force: true});
  assert.ok(result.closed, `child close unconfirmed; pid=${result.pid}; fixture preserved: ${dir}`);
  assert.notEqual(result.signal === null && result.code === 0, true);
});
