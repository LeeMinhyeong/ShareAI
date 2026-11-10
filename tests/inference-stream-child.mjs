// Disposable in-memory fixture. It imports no application services or configuration.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';

const send = message => { if (process.connected) process.send(message); };

async function main() {
  if (process.argv[2] === 'hang-control') {
    async function* uncooperative() {
      setInterval(() => {}, 1000); // Owned live handle proves a pending iterator can keep Node alive.
      send('ready');
      await new Promise(() => {});
      yield null;
    }
    for await (const event of uncooperative()) void event;
    send('unexpected-completion');
    return;
  }
  if (process.argv[2] !== 'valid') throw new Error('Invalid fixture mode');
  const source = readFileSync(new URL('../src/upstream/inference.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(code, {exports, TextDecoder, fetch() { throw new Error('Unexpected network call'); }, require() { throw new Error('Unexpected import'); }});
  const text = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const response = new Response(text, {headers:{'Content-Type':'Text/Event-Stream; charset=utf-8'}});
  const events = await exports.infer('openai', {kind:'api_key', token:'sk-synthetic'},
    {model:'gpt-test', messages:[{role:'user', content:'hello'}]},
    'https://stream-fixture.invalid/v1/chat/completions', undefined, async () => response);
  send('ready');
  const actual = [];
  for await (const event of events) actual.push(event);
  const matches = isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), [{text:'hello'}, {finish:'stop'}]);
  send(matches ? 'complete' : 'invalid-events');
}

try { await main(); }
catch { send('fixture-error'); }
finally { if (process.connected) process.disconnect(); }
