import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';

export type SiwcCredential = {
  issuer: string; subject: string; clientId: string; accessToken: string;
  refreshToken?: string; idToken: string; tokenType: string; expiresIn: number;
  scopes: string[]; savedAt: string; earliestRefreshAt?: number;
};
type Vault = { encrypt(value: string): string; decrypt(value: string): string };
export type SiwcSnapshot = { revision: string; credential: SiwcCredential };
const registrationKey = (clientId: string) => createHash('sha256').update(clientId).digest('hex');
function validate(c: SiwcCredential): void {
  if (!c || c.issuer !== 'https://auth.openai.com' || !c.subject?.trim() || !c.clientId?.trim() || c.clientId === 'dynamic_agent_client' || !c.accessToken || !c.idToken || c.tokenType !== 'Bearer' || !Number.isSafeInteger(c.expiresIn) || c.expiresIn <= 0 || !Array.isArray(c.scopes) || !c.scopes.every(s => typeof s === 'string' && !!s) || !Number.isFinite(Date.parse(c.savedAt)) || (c.refreshToken !== undefined && !c.refreshToken)) throw new Error('Invalid SIWC credential');
  if (c.earliestRefreshAt !== undefined && (!Number.isSafeInteger(c.earliestRefreshAt) || c.earliestRefreshAt < 0)) throw new Error('Invalid SIWC earliest refresh time');
}

// Isolated storage primitive, not wired into routing or administrator endpoints.
// Callers must supply an authenticated vault and credentials from verified exchange.
export class SiwcStore {
  constructor(private readonly db: Database.Database, private readonly vault: Vault, options: { initialize?: boolean } = {}) {
    if (options.initialize !== false) SiwcStore.initialize(db);
  }
  // Invoke during startup, never on a latency-sensitive request path.
  static initialize(db: Database.Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS siwc_credentials (
      id TEXT PRIMARY KEY, registration_key TEXT UNIQUE NOT NULL, credentials TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh_intents (
      token_fingerprint TEXT PRIMARY KEY, attempt_id TEXT NOT NULL,
      account_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS siwc_resolved_refresh_intents (
      token_fingerprint TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS siwc_refresh_claim_versions (
      token_fingerprint TEXT PRIMARY KEY, source_revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS siwc_authorization_intents (
      attempt_id TEXT PRIMARY KEY, account_id TEXT NOT NULL
    )`);
    db.transaction(() => {
      if (!(db.pragma('table_info(siwc_credentials)') as { name: string }[]).some(c => c.name === 'revision')) {
        db.exec("ALTER TABLE siwc_credentials ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
      }
      if (!(db.pragma('table_info(siwc_resolved_refresh_intents)') as { name: string }[]).some(c => c.name === 'result_revision')) {
        db.exec('ALTER TABLE siwc_resolved_refresh_intents ADD COLUMN result_revision TEXT');
      }
    }).immediate();
  }
  // File databases use a separate nonblocking connection for refresh operations.
  refreshConnection(): { store: SiwcStore; close: () => void } {
    if (this.db.memory) return { store: this, close: () => {} };
    const db = new Database(this.db.name, { timeout: 0, fileMustExist: true });
    const store = Object.create(SiwcStore.prototype) as SiwcStore;
    Object.assign(store, { db, vault: this.vault });
    return { store, close: () => db.close() };
  }
  private assertUnused(token: string | undefined): void {
    if (!token) return;
    const fingerprint = createHash('sha256').update(JSON.stringify(['openai', token])).digest('hex');
    if (this.db.prepare('SELECT 1 FROM oauth_refresh_intents WHERE token_fingerprint = ?').get(fingerprint)) throw new Error('SIWC refresh token already attempted');
  }
  create(id: string, credential: SiwcCredential): void {
    validate(credential);
    if (!id.trim()) throw new Error('Invalid account');
    this.db.transaction(() => {
      this.assertUnused(credential.refreshToken);
      this.db.prepare('INSERT INTO siwc_credentials (id, registration_key, credentials, revision) VALUES (?, ?, ?, ?)').run(id, registrationKey(credential.clientId), this.vault.encrypt(JSON.stringify(credential)), randomUUID());
    }).immediate();
  }
  read(id: string): SiwcCredential | null {
    return this.readSnapshot(id)?.credential ?? null;
  }
  readSnapshot(id: string): SiwcSnapshot | null {
    const row = this.db.prepare('SELECT credentials, revision FROM siwc_credentials WHERE id = ?').get(id) as { credentials: string; revision: string } | undefined;
    if (!row) return null;
    const credential = JSON.parse(this.vault.decrypt(row.credentials)) as SiwcCredential;
    if ((credential as unknown as { invalidated?: boolean }).invalidated === true) return null;
    validate(credential);
    return { credential, revision: row.revision };
  }
  readRegistrationSnapshot(id: string): { revision: string; identity: { issuer: string; subject: string; clientId: string }; credential?: SiwcCredential } | null {
    const row = this.db.prepare('SELECT credentials, revision FROM siwc_credentials WHERE id = ?').get(id) as { credentials: string; revision: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(this.vault.decrypt(row.credentials));
    if (value.invalidated === true) {
      if (value.issuer !== 'https://auth.openai.com' || typeof value.subject !== 'string' || !value.subject.trim() || typeof value.clientId !== 'string' || !value.clientId.trim() || value.clientId === 'dynamic_agent_client') throw new Error('Invalid SIWC identity');
      return { revision: row.revision, identity: { issuer: value.issuer, subject: value.subject, clientId: value.clientId } };
    }
    validate(value);
    return { revision: row.revision, identity: { issuer: value.issuer, subject: value.subject, clientId: value.clientId }, credential: value };
  }
  // The returned credential is sensitive and is only for a future revocation caller.
  // Unresolved operations may have issued credentials not covered by revocation.
  logout(id: string): { credential: SiwcCredential; remoteUncertain: boolean; revision: string } {
    return this.db.transaction(() => {
      const snapshot = this.readSnapshot(id);
      if (!snapshot) throw new Error('SIWC credential unavailable');
      const credential = snapshot.credential;
      const remoteUncertain = !!this.db.prepare('SELECT 1 FROM oauth_refresh_intents i WHERE i.account_id = ? AND NOT EXISTS (SELECT 1 FROM siwc_resolved_refresh_intents r WHERE r.token_fingerprint = i.token_fingerprint) LIMIT 1').get(id)
        || !!this.db.prepare('SELECT 1 FROM siwc_authorization_intents WHERE account_id = ? LIMIT 1').get(id);
      const { issuer, subject, clientId } = credential;
      const revision = randomUUID();
      this.db.prepare('UPDATE siwc_credentials SET credentials = ?, revision = ? WHERE id = ?').run(this.vault.encrypt(JSON.stringify({ invalidated: true, issuer, subject, clientId })), revision, id);
      return { credential, remoteUncertain, revision };
    }).immediate();
  }
  logoutStillCertain(id: string, revision: string): boolean {
    return this.db.transaction(() => {
      const current = this.readRegistrationSnapshot(id);
      return !!current && current.revision === revision && !current.credential
        && !this.db.prepare('SELECT 1 FROM siwc_authorization_intents WHERE account_id = ? LIMIT 1').get(id)
        && !this.db.prepare('SELECT 1 FROM oauth_refresh_intents i WHERE i.account_id = ? AND NOT EXISTS (SELECT 1 FROM siwc_resolved_refresh_intents r WHERE r.token_fingerprint = i.token_fingerprint) LIMIT 1').get(id);
    }).immediate();
  }
  claimAuthorization(id: string, revision: string): string {
    return this.db.transaction(() => {
      const current = this.readRegistrationSnapshot(id);
      if (!current || current.revision !== revision) throw new Error('SIWC credentials changed before authorization');
      const attemptId = randomUUID();
      this.db.prepare('INSERT INTO siwc_authorization_intents (attempt_id, account_id) VALUES (?, ?)').run(attemptId, id);
      return attemptId;
    }).immediate();
  }
  finishAuthorization(id: string, attemptId: string): void {
    const result = this.db.prepare('DELETE FROM siwc_authorization_intents WHERE account_id = ? AND attempt_id = ?').run(id, attemptId);
    if (!result.changes) throw new Error('SIWC authorization intent unavailable');
  }
  // Read claim, completion and credential in one SQLite snapshot; never trust a
  // replacement or an old completion without its exact committed revision.
  observeRefresh(id: string, expected: SiwcSnapshot): { status: 'pending' | 'changed' | 'missing' } | { status: 'complete'; credential: SiwcCredential; snapshot: SiwcSnapshot } {
    return this.db.transaction(() => {
      if (!expected.credential.refreshToken) return { status: 'missing' as const };
      const fingerprint = createHash('sha256').update(JSON.stringify(['openai', expected.credential.refreshToken])).digest('hex');
      const intent = this.db.prepare('SELECT r.result_revision, v.source_revision FROM oauth_refresh_intents i LEFT JOIN siwc_resolved_refresh_intents r ON r.token_fingerprint = i.token_fingerprint LEFT JOIN siwc_refresh_claim_versions v ON v.token_fingerprint = i.token_fingerprint WHERE i.token_fingerprint = ? AND i.account_id = ?').get(fingerprint, id) as { result_revision: string | null; source_revision: string | null } | undefined;
      if (!intent || !intent.source_revision) return { status: 'missing' as const };
      if (intent.source_revision !== expected.revision) return { status: 'changed' as const };
      const current = this.readSnapshot(id);
      if (!current) return { status: 'changed' as const };
      if (intent.result_revision && current.revision === intent.result_revision && current.credential.issuer === expected.credential.issuer && current.credential.subject === expected.credential.subject && current.credential.clientId === expected.credential.clientId && current.credential.refreshToken !== expected.credential.refreshToken) return { status: 'complete' as const, credential: current.credential, snapshot: current };
      if (current.revision !== expected.revision || JSON.stringify(current.credential) !== JSON.stringify(expected.credential) || intent.result_revision) return { status: 'changed' as const };
      return { status: 'pending' as const };
    })();
  }
  claimRefresh(id: string, expected: SiwcSnapshot) {
    if (!expected || typeof expected !== 'object' || typeof expected.revision !== 'string' || !expected.credential) throw new Error('SIWC expected credential snapshot required');
    validate(expected.credential);
    return this.db.transaction(() => {
      const snapshot = this.readSnapshot(id);
      const credential = snapshot?.credential;
      if (!snapshot || !credential?.refreshToken) throw new Error('SIWC refresh unavailable');
      if (snapshot.revision !== expected.revision || JSON.stringify(credential) !== JSON.stringify(expected.credential)) throw new Error('SIWC credentials changed before refresh');
      if (credential.earliestRefreshAt !== undefined && Date.now() < credential.earliestRefreshAt * 1000) throw new Error('SIWC refresh too early');
      const fingerprint = createHash('sha256').update(JSON.stringify(['openai', credential.refreshToken])).digest('hex');
      const attemptId = randomUUID();
      const row = this.db.prepare('SELECT revision FROM siwc_credentials WHERE id = ?').get(id) as { revision: string };
      const result = this.db.prepare('INSERT OR IGNORE INTO oauth_refresh_intents (token_fingerprint, attempt_id, account_id, created_at) VALUES (?, ?, ?, ?)').run(fingerprint, attemptId, id, new Date().toISOString());
      if (!result.changes) throw new Error('SIWC refresh already attempted or uncertain');
      this.db.prepare('INSERT INTO siwc_refresh_claim_versions (token_fingerprint, source_revision) VALUES (?, ?)').run(fingerprint, row.revision);
      return { fingerprint, attemptId, version: row.revision, credential };
    }).immediate();
  }
  finishRefresh(id: string, intent: ReturnType<SiwcStore['claimRefresh']>, next: SiwcCredential): SiwcSnapshot {
    validate(next);
    return this.db.transaction(() => {
      const current = this.read(id);
      const row = this.db.prepare('SELECT revision FROM siwc_credentials WHERE id = ?').get(id) as { revision: string } | undefined;
      const claimed = this.db.prepare('SELECT 1 FROM oauth_refresh_intents WHERE token_fingerprint = ? AND attempt_id = ? AND account_id = ?').get(intent.fingerprint, intent.attemptId, id);
      if (!claimed || !current || row?.revision !== intent.version) throw new Error('SIWC credentials changed during refresh');
      if (current.issuer !== next.issuer || current.subject !== next.subject || current.clientId !== next.clientId) throw new Error('SIWC identity mismatch');
      if (!next.refreshToken || next.refreshToken === current.refreshToken) throw new Error('SIWC refresh token not rotated');
      this.assertUnused(next.refreshToken);
      const revision = randomUUID();
      this.db.prepare('UPDATE siwc_credentials SET credentials = ?, revision = ? WHERE id = ?').run(this.vault.encrypt(JSON.stringify(next)), revision, id);
      this.db.prepare('INSERT INTO siwc_resolved_refresh_intents (token_fingerprint, result_revision) VALUES (?, ?)').run(intent.fingerprint, revision);
      return { revision, credential: next };
    }).immediate();
  }
  replace(id: string, credential: SiwcCredential): void {
    validate(credential);
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT credentials FROM siwc_credentials WHERE id = ?').get(id) as { credentials: string } | undefined;
      const current = row ? JSON.parse(this.vault.decrypt(row.credentials)) as SiwcCredential : null;
      if (!current || current.issuer !== credential.issuer || current.subject !== credential.subject || current.clientId !== credential.clientId) throw new Error('SIWC identity mismatch');
      this.assertUnused(credential.refreshToken);
      this.db.prepare('UPDATE siwc_credentials SET credentials = ?, revision = ? WHERE id = ?').run(this.vault.encrypt(JSON.stringify(credential)), randomUUID(), id);
    }).immediate();
  }
  invalidateRefresh(id: string, intent: ReturnType<SiwcStore['claimRefresh']>): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM siwc_credentials WHERE id = ?').get(id) as { revision: string } | undefined;
      const claimed = this.db.prepare('SELECT 1 FROM oauth_refresh_intents WHERE token_fingerprint = ? AND attempt_id = ? AND account_id = ?').get(intent.fingerprint, intent.attemptId, id);
      if (!claimed || row?.revision !== intent.version) throw new Error('SIWC credentials changed during refresh');
      const { issuer, subject, clientId } = intent.credential;
      this.db.prepare('UPDATE siwc_credentials SET credentials = ?, revision = ? WHERE id = ?').run(this.vault.encrypt(JSON.stringify({ invalidated: true, issuer, subject, clientId })), randomUUID(), id);
    }).immediate();
  }
}
