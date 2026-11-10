import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getSiwcHostId, SiwcAttempt } from '../src/upstream/siwc-session.ts';

test('host ID persists across database connections', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'siwc-test-'));
  try {
    const file = join(dir, 'test.sqlite');
    let db = new Database(file);
    const a = getSiwcHostId(db);
    db.close();
    db = new Database(file);
    const b = getSiwcHostId(db);
    assert.match(a, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(a, b);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('callback consumes a state-bound registration once', () => {
  const attempt = new SiwcAttempt({hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback'});
  const state = new URL(attempt.url).searchParams.get('state');
  const result = attempt.consume(new URLSearchParams({state, code: 'fake-code', client_id: 'oaiapp_fake'}));
  assert.equal(result.clientId, 'oaiapp_fake');
  assert.equal(result.code, 'fake-code');
  assert.throws(() => attempt.consume(new URLSearchParams({state, code: 'fake-code', client_id: 'oaiapp_fake'})));
});

test('callback rejects state mismatch, OAuth denial, missing and changed clients', () => {
  const base = {hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback'};
  for (const scenario of ['state', 'denied', 'missing', 'changed', 'duplicate']) {
    const attempt = new SiwcAttempt({...base, ...(scenario === 'changed' ? {clientId: 'oaiapp_original', expectedIdentity:{issuer:'https://auth.openai.com',clientId:'oaiapp_original',subject:'selected'}} : {})});
    const state = new URL(attempt.url).searchParams.get('state');
    const params = new URLSearchParams({state, code: 'fake-code', client_id: 'oaiapp_fake'});
    if (scenario === 'state') params.set('state', 'wrong');
    if (scenario === 'denied') params.set('error', 'access_denied');
    if (scenario === 'missing') params.delete('client_id');
    if (scenario === 'duplicate') params.append('state', state);
    assert.throws(() => attempt.consume(params), scenario);
    assert.throws(() => attempt.consume(params), 'failed attempts cannot be replayed');
  }
});

test('wrong state cannot consume a legitimate pending attempt', () => {
  const attempt = new SiwcAttempt({hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback'});
  const state = new URL(attempt.url).searchParams.get('state');
  assert.throws(() => attempt.consume(new URLSearchParams({state: 'wrong', code: 'fake', client_id: 'oaiapp_fake'})));
  assert.equal(attempt.consume(new URLSearchParams({state, code: 'fake', client_id: 'oaiapp_fake'})).clientId, 'oaiapp_fake');
});

test('session carries returning hints without exposing them in diagnostics', async () => {
  const { inspect } = await import('node:util');
  const attempt = new SiwcAttempt({hostId:'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri:'http://127.0.0.1:54321/auth/callback', clientId:'oaiapp_original', expectedIdentity:{issuer:'https://auth.openai.com',clientId:'oaiapp_original',subject:'selected'}, idTokenHint:'secret-token', loginHint:'person@example.com'});
  assert.equal(new URL(attempt.url).searchParams.get('id_token_hint'), 'secret-token');
  assert.ok(!inspect(attempt).includes('secret-token'));
  assert.ok(!JSON.stringify(attempt).includes('secret-token'));
});

test('registration recovery uses provisional issued client without pretending identity is verified', () => {
  const attempt = new SiwcAttempt({hostId:'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri:'http://127.0.0.1:54321/auth/callback', provisionalClientId:'oaiapp_provisional'});
  const params = new URL(attempt.url).searchParams;
  assert.equal(params.get('client_id'), 'oaiapp_provisional');
  assert.equal(params.has('agent_name_hint'), false);
  const exchange = attempt.consume(new URLSearchParams({state:params.get('state'), code:'new-code'}));
  assert.equal(exchange.clientId, 'oaiapp_provisional');
  assert.equal(exchange.mode, 'registration');
});

test('selected identity cannot change after attempt creation', () => {
  const identity = {issuer:'https://auth.openai.com',clientId:'oaiapp_original',subject:'original'};
  const options = {hostId:'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012',redirectUri:'http://127.0.0.1:54321/auth/callback',clientId:'oaiapp_original',expectedIdentity:identity};
  const attempt = new SiwcAttempt(options);
  const state = new URL(attempt.url).searchParams.get('state');
  identity.subject = 'other'; options.clientId = 'other';
  const exchange = attempt.consume(new URLSearchParams({state,code:'fake'}));
  assert.equal(exchange.clientId, 'oaiapp_original');
  assert.equal(exchange.expectedIdentity.subject, 'original');
});

test('returning attempts require selected identity and carry it to exchange', () => {
  const base = {hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback', clientId: 'oaiapp_original'};
  assert.throws(() => new SiwcAttempt(base));
  const expectedIdentity = {issuer: 'https://auth.openai.com', clientId: 'oaiapp_original', subject: 'selected'};
  const attempt = new SiwcAttempt({...base, expectedIdentity});
  const state = new URL(attempt.url).searchParams.get('state');
  assert.deepEqual(attempt.consume(new URLSearchParams({state, code: 'fake'})).expectedIdentity, expectedIdentity);
});

test('returning callback may omit its unchanged client ID', () => {
  const attempt = new SiwcAttempt({hostId: 'urn:uuid:9fdd3d0e-944d-4ddd-b5df-123456789012', redirectUri: 'http://127.0.0.1:54321/auth/callback', clientId: 'oaiapp_original', expectedIdentity:{issuer:'https://auth.openai.com',clientId:'oaiapp_original',subject:'selected'}});
  const state = new URL(attempt.url).searchParams.get('state');
  assert.equal(attempt.consume(new URLSearchParams({state, code: 'fake'})).clientId, 'oaiapp_original');
});

