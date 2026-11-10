import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {migrateLedger, openAttempt, dispatchOpenAttemptOnce} from '../src/db/durable-ledger-foundation.ts';
import {UpstreamError} from '../src/upstream/inference.ts';
import {strictInference} from '../src/upstream/inference.ts';

async function adapter() {
  try { return await import('../src/upstream/sse-terminal-adapter.ts'); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; }
}
async function server(handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  return {url:`http://127.0.0.1:${s.address().port}`, close:()=>new Promise(resolve => s.close(resolve)), closeAllConnections:()=>s.closeAllConnections()};
}
const request = {model:'gpt-test', messages:[{role:'user',content:'hello'}]};
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('fixture timed out')), 5000);})]); }
  finally { clearTimeout(timer); }
}

test('adapter waits for real upstream stream terminal, not HTTP headers', async () => {
  const {settleInferenceStream} = await adapter();
  assert.equal(typeof settleInferenceStream, 'function', 'terminal adapter must exist');
  let release; const ready = new Promise(r => { release = r; });
  let sent; const sentPromise = new Promise(r => { sent = r; });
  const s = await server(async (_req, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'); sent();
    await ready; res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  try {
    let settled = false; const events = [];
    const pending = settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,s.url), e => {events.push(e);}).finally(() => {settled = true;});
    await bounded(Promise.race([sentPromise, pending.then(() => {throw new Error('settled before fixture barrier');})]));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(settled, false);
    release();
    assert.deepEqual(await pending, {outcome:'SUCCESS', terminal:{finish:'stop'}});
    assert.equal(events.some(e => e.text === 'hello'), true);
  } finally { release(); await s.close(); }
});

for (const [name, body] of [
  ['truncated', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
  ['malformed', 'data: not-json\n\n'],
  ['upstream error', 'data: {"error":{"code":"other"}}\n\n'],
  ['partial terminal frame', 'data: [DONE]'],
]) test(`${name} stream rejects rather than reporting success`, async () => {
  const {settleInferenceStream} = await adapter();
  const s = await server((_req, res) => { res.writeHead(200, {'content-type':'text/event-stream'}); res.end(body); });
  try { await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,s.url), () => {}), UpstreamError); }
  finally { await s.close(); }
});

test('cancelled real stream rejects and does not report success', async () => {
  const {settleInferenceStream} = await adapter();
  let received; const observed = new Promise(r => { received = r; });
  const s = await server((_req, res) => {res.writeHead(200, {'content-type':'text/event-stream'}); res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');});
  const controller = new AbortController();
  try {
    const pending = settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,s.url,controller.signal), () => received(), controller.signal);
    await bounded(Promise.race([observed, pending.then(() => {throw new Error('settled before fixture barrier');})])); controller.abort();
    await assert.rejects(pending, e => e.name === 'AbortError');
  } finally { controller.abort(); s.closeAllConnections(); await s.close(); }
});

test('consumer errors are never classified as upstream 429', async () => {
  const {settleInferenceStream} = await adapter();
  const s = await server((_req, res) => {res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');});
  try { await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,s.url), () => {throw new UpstreamError(429, 'consumer');}), /consumer/); }
  finally { await s.close(); }
});

test('HTTP 429 becomes a durable restriction before coordinator returns', async () => {
  const {settleInferenceStream} = await adapter();
  const dir = mkdtempSync(join(tmpdir(), 'ledger-stream-')); const file = join(dir,'db.sqlite');
  const db = new Database(file); const s = await server((_req, res) => {res.writeHead(429); res.end();});
  try {
    migrateLedger(db); assert.equal(openAttempt(db, 'attempt1'), true);
    const result = await dispatchOpenAttemptOnce(file, 'attempt1', () => true,
      () => settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,s.url), () => {}), r => r.outcome);
    assert.equal(result.outcome, 'UNKNOWN_429');
    assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts WHERE id=?').get('attempt1').state, 'UNKNOWN_429');
    assert.equal(db.prepare('SELECT count(*) AS n FROM phase4_experimental_ledger_restrictions').get().n, 1);
    assert.equal(openAttempt(db, 'attempt2'), false);
  } finally { db.close(); await s.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('truncated provider stream leaves claimed attempt OPEN and fenced', async () => {
  const {settleInferenceStream} = await adapter();
  const dir = mkdtempSync(join(tmpdir(), 'ledger-stream-')); const file = join(dir,'db.sqlite');
  const db = new Database(file); const s = await server((_req, res) => {res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');});
  try {
    migrateLedger(db); assert.equal(openAttempt(db, 'attempt1'), true);
    await assert.rejects(dispatchOpenAttemptOnce(file, 'attempt1', () => true,
      () => settleInferenceStream(strictInference('openai',{kind:'api_key',token:'sk-test'},request,s.url), () => {}), r => r.outcome), /prematurely/);
    assert.equal(db.prepare('SELECT state FROM phase4_experimental_ledger_attempts WHERE id=?').get('attempt1').state, 'OPEN');
    assert.equal(openAttempt(db, 'attempt2'), false);
  } finally { db.close(); await s.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('unverified SIWC in-stream usage limit rejects', async () => {
  const {settleInferenceStream} = await adapter();
  const s = await server((_req, res) => {res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: {"type":"error","error":{"code":"subscription_sharing_usage_limit_exceeded"}}\n\n');});
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) => original(s.url, init);
  try { await assert.rejects(settleInferenceStream(strictInference('openai',{kind:'siwc',token:'synthetic'},request), () => {}), /Upstream stream failed/); }
  finally { globalThis.fetch = original; await s.close(); }
});
