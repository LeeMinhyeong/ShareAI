/**
 * 업스트림 계정 Repository
 */
import { getDb } from '../client.js';
import type { UpstreamAccount, AccountMeta, QuotaInfo, CredentialType } from '../schema.js';
import { createHash, randomUUID } from 'crypto';
import { parseStoredCredentials } from '../../upstream/oauth.js';
import { CredentialVault } from '../../utils/encryption.js';

const vault = new CredentialVault();
const refreshFingerprint = (provider: string, token: string) => createHash('sha256').update(JSON.stringify([provider, token])).digest('hex');
type AdminAccount = Omit<UpstreamAccount, 'credentials' | 'meta' | 'quotaInfo'> & { credentialStatus: 'available' | 'unavailable' };

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class RefreshIntentError extends Error {
  constructor() { super('Refresh outcome uncertain or token already used; reauthentication required'); }
}

export class AccountRepository {
  /** Reserve this provider/token forever before sending it to the provider. */
  claimRefresh(id: string, expected: string): { account: UpstreamAccount; credentialVersion: string; attemptId: string; fingerprint: string } {
    const db = getDb();
    return db.transaction(() => {
      const account = this.findById(id);
      if (!account || account.credentialType !== 'oauth' || account.credentials !== expected || !['active', 'quota_exceeded'].includes(account.status))
        throw new Error('Account unavailable for refresh');
      const token = parseStoredCredentials(account.credentials)?.refreshToken;
      if (!token) throw new Error('Account has no refresh token');
      const fingerprint = refreshFingerprint(account.provider, token);
      const attemptId = randomUUID();
      const result = db.prepare('INSERT OR IGNORE INTO oauth_refresh_intents (token_fingerprint, attempt_id, account_id, created_at) VALUES (?, ?, ?, ?)')
        .run(fingerprint, attemptId, id, new Date().toISOString());
      if (!result.changes) throw new RefreshIntentError();
      const row = db.prepare('SELECT credentials FROM upstream_accounts WHERE id = ?').get(id) as { credentials: string };
      return { account, credentialVersion: row.credentials, attemptId, fingerprint };
    }).immediate();
  }

  finishRefresh(id: string, credentialVersion: string, credentialRevision: number, fingerprint: string, attemptId: string, credentials: string, meta: AccountMeta): UpstreamAccount | null {
    const db = getDb();
    return db.transaction(() => {
      const intent = db.prepare('SELECT 1 FROM oauth_refresh_intents WHERE token_fingerprint = ? AND attempt_id = ? AND account_id = ?').get(fingerprint, attemptId, id);
      const current = this.findById(id);
      const row = db.prepare('SELECT credentials FROM upstream_accounts WHERE id = ?').get(id) as { credentials: string } | undefined;
      if (!intent || !current || current.credentialType !== 'oauth' || current.credentialRevision !== credentialRevision || row?.credentials !== credentialVersion) throw new Error('Account credentials changed during refresh');
      db.prepare('UPDATE upstream_accounts SET credentials = ?, meta = ?, updated_at = ?, state_revision = state_revision + 1, last_refresh_revision = credential_revision + 1 WHERE id = ?')
        .run(vault.encrypt(credentials), JSON.stringify({ ...current.meta, ...meta }), new Date().toISOString(), id);
      return current.status === 'active' || current.status === 'quota_exceeded' ? this.findById(id) : null;
    }).immediate();
  }
  hasRefreshIntent(provider: string, token: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM oauth_refresh_intents WHERE token_fingerprint = ?').get(refreshFingerprint(provider, token));
  }
  markRefreshError(id: string, credentialVersion: string, observed: UpstreamAccount): void {
    getDb().prepare(`UPDATE upstream_accounts SET status = 'error', last_error = ?, updated_at = ?, request_revision = request_revision + 1
      WHERE id = ? AND credential_type = 'oauth' AND credentials = ? AND state_revision = ? AND status IN ('active', 'quota_exceeded')`)
      .run('재로그인 필요: 토큰 갱신 결과 불확정', new Date().toISOString(), id, credentialVersion, observed.stateRevision);
  }
  findById(id: string): UpstreamAccount | null {
    const row = getDb().prepare('SELECT * FROM upstream_accounts WHERE id = ?').get(id);
    return row ? this.rowToAccount(row) : null;
  }

  /**
   * 라우팅 후보 (active + quota_exceeded). error/disabled 는 제외.
   */
  findActiveByProvider(provider: string): UpstreamAccount[] {
    const rows = getDb()
      .prepare(`
        SELECT * FROM upstream_accounts
        WHERE provider = ? AND status IN ('active', 'quota_exceeded')
        ORDER BY priority ASC, name ASC
      `)
      .all(provider);
    return this.readUsableRows(rows);
  }

  create(data: {
    name: string;
    provider: 'anthropic' | 'openai' | 'google';
    credentialType: CredentialType;
    credentials: string;
    meta?: AccountMeta;
    dailyQuota?: number;
    priority?: number;
    weight?: number;
  }): UpstreamAccount {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);

    getDb().prepare(`
      INSERT INTO upstream_accounts (
        id, name, provider, credential_type, credentials, meta, quota_info,
        status, last_used, last_error,
        daily_quota, used_today, quota_reset_at,
        priority, weight,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', NULL, NULL, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.provider,
      data.credentialType,
      vault.encrypt(data.credentials),
      JSON.stringify(data.meta ?? {}),
      data.dailyQuota ?? 0,
      tomorrow.toISOString(),
      data.priority ?? 0,
      data.weight ?? 1,
      now,
      now
    );

    return this.findById(id)!;
  }

  update(
    id: string,
    data: Partial<
      Pick<
        UpstreamAccount,
        'name' | 'status' | 'lastError' | 'dailyQuota' | 'priority' | 'weight' | 'credentials' | 'credentialType' | 'meta'
      >
    >
  ): void {
    const updates: string[] = [];
    const values: any[] = [];
    const set = (col: string, v: any) => {
      updates.push(`${col} = ?`);
      values.push(v);
    };

    if (data.name !== undefined) set('name', data.name);
    if (data.status !== undefined) set('status', data.status);
    if (data.lastError !== undefined) set('last_error', data.lastError);
    if (data.dailyQuota !== undefined) set('daily_quota', data.dailyQuota);
    if (data.priority !== undefined) set('priority', data.priority);
    if (data.weight !== undefined) set('weight', data.weight);
    if (data.credentialType !== undefined) set('credential_type', data.credentialType);
    if (data.credentials !== undefined && data.credentials !== '') set('credentials', vault.encrypt(data.credentials));
    // Administrative credential replacement is a new generation even if the
    // access token is identical; internal refresh writes do not use update().
    if (data.credentialType !== undefined || (data.credentials !== undefined && data.credentials !== '')) updates.push('state_revision = state_revision + 1');
    if (data.meta !== undefined) set('meta', JSON.stringify(data.meta));

    if (updates.length === 0) return;
    set('updated_at', new Date().toISOString());
    values.push(id);
    getDb().prepare(`UPDATE upstream_accounts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Atomically compare the observed credential and preserve current metadata. */
  saveCredentialsIfUnchanged(id: string, expected: string, credentials: string, meta: AccountMeta): boolean {
    const db = getDb();
    return db.transaction(() => {
      const current = this.findById(id);
      if (!current || current.credentialType !== 'oauth' || current.credentials !== expected) return false;
      db.prepare('UPDATE upstream_accounts SET credentials = ?, meta = ?, updated_at = ? WHERE id = ?')
        .run(vault.encrypt(credentials), JSON.stringify({ ...current.meta, ...meta }), new Date().toISOString(), id);
      return true;
    }).immediate();
  }

  markErrorIfCredentialsUnchanged(id: string, expected: string, error: string): void {
    const db = getDb();
    db.transaction(() => {
      const current = this.findById(id);
      if (current?.credentialType === 'oauth' && current.credentials === expected && current.status !== 'disabled') this.markError(id, error);
    }).immediate();
  }

  saveQuotaInfo(id: string, info: QuotaInfo): void {
    getDb()
      .prepare('UPDATE upstream_accounts SET quota_info = ? WHERE id = ?')
      .run(JSON.stringify(info), id);
  }

  /** 성공 사용 기록. quota_exceeded 상태였다면 active 로 복귀 */
  markUsed(id: string, observed?: UpstreamAccount, usedToken?: string, countUsage = true): boolean {
    const now = new Date().toISOString();
    const db = getDb();
    return db.transaction(() => {
      const current = this.findById(id);
      if (countUsage && current) db.prepare('UPDATE upstream_accounts SET last_used = ?, used_today = used_today + 1, updated_at = ? WHERE id = ?').run(now, now, id);
      if (!current || !['active', 'quota_exceeded'].includes(current.status) || (observed && (current.stateRevision !== observed.stateRevision || (usedToken === undefined ? current.credentials !== observed.credentials : (parseStoredCredentials(current.credentials)?.accessToken ?? current.credentials) !== usedToken)))) return false;
      if (current.status === 'quota_exceeded') db.prepare("UPDATE upstream_accounts SET status = 'active', last_error = NULL, updated_at = ?, request_revision = request_revision + 1 WHERE id = ?").run(now, id);
      return true;
    }).immediate();
  }

  /** Apply an in-flight request result only to the state it observed. */
  recordObservedFailure(id: string, status: number, message: string, observed?: UpstreamAccount, usedToken?: string): boolean {
    const db = getDb();
    return db.transaction(() => {
      const current = this.findById(id);
      if (observed && (!current || current.stateRevision !== observed.stateRevision || (usedToken === undefined
        ? current.credentials !== observed.credentials
        : (parseStoredCredentials(current.credentials)?.accessToken ?? current.credentials) !== usedToken))) return false;
      const nextStatus = status === 429 ? 'quota_exceeded' : status === 401 || status === 403 ? 'error' : null;
      const guard = observed ? ' AND state_revision = ?' : '';
      const params = observed ? [observed.stateRevision] : [];
      const result = db.prepare(`UPDATE upstream_accounts SET status = COALESCE(?, status), last_error = ?, updated_at = ?, request_revision = request_revision + 1
        WHERE id = ? AND status IN ('active', 'quota_exceeded')${guard}`)
        .run(nextStatus, message, new Date().toISOString(), id, ...params);
      return result.changes > 0;
    }).immediate();
  }

  markQuotaExceeded(id: string, message = 'Rate limited by upstream (429)'): void {
    getDb().prepare(`
      UPDATE upstream_accounts SET status = 'quota_exceeded', last_error = ?, updated_at = ?, request_revision = request_revision + 1 WHERE id = ?
    `).run(message, new Date().toISOString(), id);
  }

  markError(id: string, error: string): void {
    getDb().prepare(`
      UPDATE upstream_accounts SET status = 'error', last_error = ?, updated_at = ?, request_revision = request_revision + 1 WHERE id = ?
    `).run(error, new Date().toISOString(), id);
  }

  setLastError(id: string, error: string): void {
    getDb().prepare('UPDATE upstream_accounts SET last_error = ?, updated_at = ?, request_revision = request_revision + 1 WHERE id = ?')
      .run(error, new Date().toISOString(), id);
  }

  resetDailyQuotas(): void {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    const now = new Date().toISOString();
    getDb().prepare(`
      UPDATE upstream_accounts
      SET used_today = 0,
          quota_reset_at = ?,
          status = CASE WHEN status = 'quota_exceeded' THEN 'active' ELSE status END,
          request_revision = request_revision + 1,
          updated_at = ?
      WHERE quota_reset_at <= ?
    `).run(tomorrow.toISOString(), now, now);
  }

  findAll(): UpstreamAccount[] {
    const rows = getDb().prepare('SELECT * FROM upstream_accounts ORDER BY provider, priority, name').all();
    return this.readUsableRows(rows);
  }

  /** Admin views never expose stored or decrypted credentials, even on failure. */
  findAllAdmin(): AdminAccount[] {
    return getDb().prepare('SELECT * FROM upstream_accounts ORDER BY provider, priority, name').all().map(row => this.rowToAdmin(row));
  }

  findByIdAdmin(id: string): AdminAccount | null {
    const row = getDb().prepare('SELECT * FROM upstream_accounts WHERE id = ?').get(id);
    return row ? this.rowToAdmin(row) : null;
  }

  private readUsableRows(rows: any[]): UpstreamAccount[] {
    const accounts: UpstreamAccount[] = [];
    for (const row of rows) {
      let credentials: string;
      try { credentials = vault.decrypt(row.credentials); } catch { continue; }
      accounts.push(this.rowToAccount(row, credentials));
    }
    return accounts;
  }

  private rowToAdmin(row: any): AdminAccount {
    let credentialStatus: AdminAccount['credentialStatus'] = 'available';
    try { vault.decrypt(row.credentials); } catch { credentialStatus = 'unavailable'; }
    const { credentials, meta, quotaInfo, ...safe } = this.rowToAccount(row, '');
    // Upstream error text can contain old credentials even after replacement.
    // Preserve it in storage, but never return it through the admin API.
    const lastError = credentialStatus === 'unavailable'
      ? 'Credential unavailable; verify the encryption key or replace credentials'
      : safe.lastError ? 'Account error details redacted' : null;
    return { ...safe, lastError, credentialStatus };
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM upstream_accounts WHERE id = ?').run(id);
  }

  private rowToAccount(row: any, decrypted?: string): UpstreamAccount {
    // Unmarked legacy plaintext cannot be distinguished safely from corrupted
    // ciphertext or a ciphertext encrypted under a different key.
    const credentials = decrypted ?? vault.decrypt(row.credentials);

    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      credentialType: row.credential_type,
      credentials,
      meta: parseJson<AccountMeta>(row.meta, {}),
      quotaInfo: parseJson<QuotaInfo | null>(row.quota_info, null),
      status: row.status,
      stateRevision: row.state_revision,
      credentialRevision: row.credential_revision,
      lastRefreshRevision: row.last_refresh_revision,
      lastUsed: row.last_used ? new Date(row.last_used) : null,
      lastError: row.last_error,
      dailyQuota: row.daily_quota,
      usedToday: row.used_today,
      quotaResetAt: new Date(row.quota_reset_at),
      priority: row.priority,
      weight: row.weight,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
