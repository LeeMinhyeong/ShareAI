// ADR 0019 item 8, SIWC side: selection and the explanation of an empty selection share one
// per-account rule set, so every SIWC block that hides an account from selection is also the wait
// reported for it, and accounts outside the user's ACL never count. Manager-level, test-owned SQLite.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {NODE_ENV:'test', DATABASE_URL:'sqlite::memory:', ENCRYPTION_KEY:'a'.repeat(64), ADMIN_API_KEY:'x'.repeat(24), LOG_LEVEL:'error', LOG_PRETTY:'false'});
await (await import('./helpers/fresh-db.mjs')).useFreshFileDatabase();
const {initDatabase, closeDatabase, getDb} = await import('../src/db/client.ts');
const {refreshFingerprint} = await import('../src/db/repositories/accounts.ts');
const {AccountPoolManager, BUSY_WAIT_MS} = await import('../src/account-pool/manager.ts');
const {SiwcStore} = await import('../src/upstream/siwc-store.ts');
const {CredentialVault} = await import('../src/utils/encryption.ts');
const {arm429V2} = await import('../src/db/account-429-v2-store.ts');
initDatabase();
const db = getDb();
after(() => closeDatabase());
db.exec("CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
db.prepare("INSERT INTO users (id, api_key_hash, name, email, tier, daily_limit) VALUES (?, ?, ?, ?, 'pro', 100)").run('siwc-member', 'hash-member', 'member', 'member@example.invalid');
db.prepare("INSERT INTO users (id, api_key_hash, name, email, tier, daily_limit) VALUES (?, ?, ?, ?, 'pro', 100)").run('siwc-outsider', 'hash-outsider', 'outsider', 'outsider@example.invalid');
const store = new SiwcStore(db, new CredentialVault());
const pool = new AccountPoolManager();
const opts = {credentialTypes:['oauth', 'api_key'], includeSiwc:true};

function siwc(id, {expired = false, earliestRefreshAt, scope = 'selected', scopes = ['chatgpt.tokens.use.direct', 'offline_access']} = {}) {
  db.prepare('UPDATE siwc_access_policy SET enabled=0').run();
  db.prepare('INSERT INTO siwc_accounts VALUES (?, ?)').run(id, 'synthetic');
  db.prepare('INSERT INTO siwc_access_policy VALUES (?, 1, ?)').run(id, scope);
  if (scope === 'selected') db.prepare('INSERT INTO siwc_access_users (account_id, user_id) VALUES (?, ?)').run(id, 'siwc-member');
  const savedAt = expired ? new Date(Date.now() - 7_200_000).toISOString() : new Date().toISOString();
  store.create(id, {issuer:'https://auth.openai.com', subject:`sub-${id}`, clientId:`client-${id}`, accessToken:`at-${id}`, refreshToken:`rt-${id}`, idToken:'synthetic-id', tokenType:'Bearer',
    expiresIn:3600, scopes, savedAt, ...(earliestRefreshAt === undefined ? {} : {earliestRefreshAt})});
  return id;
}
const choose = (user = 'siwc-member') => pool.selectCandidate(user, 'gpt-5', 'openai', 'priority', opts);
const wait = (user = 'siwc-member') => pool.unavailableWaitMs(user, 'openai', opts);
async function hidden(label) {
  assert.equal(await choose(), null, `${label}: not selected`);
  return wait();
}

test('a usable SIWC account is selected, and only for a user its ACL admits', async () => {
  const id = siwc('siwc-ok');
  assert.equal((await choose())?.id, id);
  assert.equal(await choose('siwc-outsider'), null);
  assert.equal(wait('siwc-outsider'), null, 'an account outside the ACL is not a wait: 403, nothing revealed');
});

test('busy (OPEN) and excluded SIWC accounts are hidden and wait the busy hint', async () => {
  const id = siwc('siwc-open');
  db.prepare('INSERT INTO siwc_account_attempts (account_id, attempt_id) VALUES (?, ?)').run(id, 'held');
  assert.equal(await hidden('open'), BUSY_WAIT_MS);
  assert.equal(wait('siwc-outsider'), null, 'busy accounts outside the ACL stay invisible');
  const other = siwc('siwc-excluded');
  assert.equal(await pool.selectCandidate('siwc-member', 'gpt-5', 'openai', 'priority', {...opts, excludeSiwc:new Set([other])}), null);
  assert.equal(pool.unavailableWaitMs('siwc-member', 'openai', {...opts, excludeSiwc:new Set([other])}), BUSY_WAIT_MS);
});

test('a shared restriction hides the account; finite waits its duration, indefinite is a 403', async () => {
  const id = siwc('siwc-rest');
  db.transaction(() => arm429V2(db, 'siwc', id, 45_000)).immediate();
  assert.equal(await hidden('restricted'), 45_000);
  const forever = siwc('siwc-forever');
  db.transaction(() => arm429V2(db, 'siwc', forever, null)).immediate();
  assert.equal(await hidden('indefinite'), null);
});

test('a local failure backoff hides the account and waits what is left of it', async () => {
  const id = siwc('siwc-cool');
  pool.recordSiwcFailure(id, store.readSnapshot(id).revision);
  const w = await hidden('cooling');
  assert.ok(w > 4_000 && w <= 6_000, String(w));
});

test('an expired token waits for its earliest refresh time, or for a refresh in flight', async () => {
  const early = siwc('siwc-early', {expired:true, earliestRefreshAt:Math.floor(Date.now() / 1000) + 120});
  const w = await hidden('earliest refresh');
  assert.ok(w > 110_000 && w <= 120_000, String(w));
  assert.ok(early);
  const refreshing = siwc('siwc-refreshing', {expired:true});
  db.prepare('INSERT INTO oauth_refresh_intents(token_fingerprint, attempt_id, account_id, created_at) VALUES (?, ?, ?, ?)').run(refreshFingerprint('openai', `rt-${refreshing}`), 'held-refresh', refreshing, new Date().toISOString());
  assert.equal(await hidden('refresh in flight'), BUSY_WAIT_MS);
  const ready = siwc('siwc-expired-ready', {expired:true});
  assert.equal((await choose())?.id, ready, 'an expired token that may refresh now is selectable');
});

test('an account that cannot serve without an administrator is a 403', async () => {
  siwc('siwc-no-direct', {scopes:['offline_access']});
  assert.equal(await hidden('no direct-use scope'), null);
  siwc('siwc-expired-final', {expired:true, scopes:['chatgpt.tokens.use.direct']});
  assert.equal(await hidden('expired without offline access'), null);
});
