import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (process.argv[2] !== '--isolated') {
  test('429 wire values require a complete exact match', async () => {
    const result = await new Promise(resolve => {
      let child, timer, grace, ended = false, output = '';
      const finish = value => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(grace); resolve(value); };
      try {
        child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], {env:{}, stdio:['ignore','pipe','pipe']});
        for (const stream of [child.stdout, child.stderr]) {
          stream.setEncoding('utf8');
          stream.on('error', () => {});
          stream.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill(); });
        }
        child.on('error', () => finish({closed:false}));
        child.on('close', (status, signal) => finish({closed:true, status, signal, output}));
        timer = setTimeout(() => child.kill(), 15000);
        grace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish({closed:false}); }, 18000);
      } catch { finish({closed:false}); }
    });
    assert.equal(result.closed && result.signal === null, true, 'isolated test did not close');
    assert.equal(result.status, 0, result.output?.includes('BAD_WIRE_ACCEPTED') ? 'trailing line terminator accepted' : 'isolated test failed');
  });
} else {
  try {
    const {createRequire} = await import('node:module');
    const {readFileSync} = await import('node:fs');
    const vm = await import('node:vm');
    const require = createRequire(import.meta.url);
    const ts = require('typescript');
    const source = readFileSync(new URL('../src/upstream/ordinary-429-deadline.ts', import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports = {};
    const context = vm.createContext({exports, module:{exports}, process:Object.freeze({env:Object.freeze(Object.create(null))})});
    new vm.Script(code, {filename:'ordinary-429-deadline.ts'}).runInContext(context);
    const deadline = context.module.exports.ordinary429Deadline;
    const now = Date.parse('2026-01-02T03:04:05Z');
    const valid = 'Fri, 02 Jan 2026 03:05:05 GMT';
    if (deadline(now, '60') !== now + 60000 || deadline(now, valid) !== now + 60000) throw new Error('CONTROL_FAILED');
    for (const suffix of ['\n','\r','\r\n','\u2028','\u2029']) {
      if (deadline(now, '60' + suffix) !== Number.MAX_SAFE_INTEGER || deadline(now, valid + suffix) !== Number.MAX_SAFE_INTEGER) {
        process.stdout.write('BAD_WIRE_ACCEPTED\n');
        process.exitCode = 1;
        break;
      }
    }
    const hint = 'Fri, 02 Jan 2026 02:06:05 GMT';
    const server = 'Fri, 02 Jan 2026 02:04:05 GMT';
    if (deadline(now, hint, server) !== now + 121000 || deadline(now, hint, server + '\n') !== now + 5000) {
      process.stdout.write('BAD_SERVER_DATE\n');
      process.exitCode = 1;
    }
  } catch { process.stdout.write('FIXTURE_FAILURE\n'); process.exitCode = 1; }
}
