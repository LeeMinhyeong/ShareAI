import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createSiwcAuthorization, type SiwcIdentity } from './siwc.js';

// Caller supplies a dedicated local database; no implicit connection to app data.
export function getSiwcHostId(db: Database.Database): string {
  db.exec('CREATE TABLE IF NOT EXISTS siwc_host (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), host_id TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO siwc_host (singleton, host_id) VALUES (1, ?)').run(`urn:uuid:${randomUUID()}`);
  const row = db.prepare('SELECT host_id FROM siwc_host WHERE singleton = 1').get() as { host_id: string } | undefined;
  if (!row || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.host_id)) throw new Error('Invalid persisted host ID');
  return row.host_id;
}

// One in-memory attempt belongs to its loopback listener and is never reusable.
export class SiwcAttempt {
  readonly url: string;
  private readonly authorization: ReturnType<typeof createSiwcAuthorization>;
  private consumed = false;
  private readonly expiresAt = Date.now() + 10 * 60 * 1000;
  constructor(private readonly options: { hostId: string; redirectUri: string; clientId?: string; provisionalClientId?: string; expectedIdentity?: SiwcIdentity; idTokenHint?: string; loginHint?: string }) {
    if ((options.idTokenHint !== undefined || options.loginHint !== undefined) && !options.clientId) throw new Error('Hints require a selected account');
    if (options.clientId && options.provisionalClientId) throw new Error('Invalid selected identity');
    if (options.clientId && (!options.expectedIdentity || options.expectedIdentity.issuer !== 'https://auth.openai.com' || options.expectedIdentity.clientId !== options.clientId || !options.expectedIdentity.subject?.trim())) throw new Error('Invalid selected identity');
    if (!options.clientId && options.expectedIdentity) throw new Error('Invalid selected identity');
    this.authorization = createSiwcAuthorization({ ...options, clientId: options.clientId ?? options.provisionalClientId });
    this.options = { ...options, expectedIdentity: options.expectedIdentity ? { ...options.expectedIdentity } : undefined, idTokenHint: undefined, loginHint: undefined };
    this.url = this.authorization.url;
  }
  // Never serialize or inspect pending authorization material.
  toJSON() { return { type: 'SiwcAttempt', consumed: this.consumed }; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toJSON(); }
  consume(params: URLSearchParams) {
    if (this.consumed) throw new Error('SIWC attempt already consumed');
    for (const key of ['state', 'code', 'error', 'client_id']) {
      if (params.getAll(key).length > 1) throw new Error('Duplicate callback parameter');
    }
    if (Date.now() >= this.expiresAt || params.get('state') !== this.authorization.state) throw new Error('Invalid SIWC state');
    this.consumed = true;
    if (params.has('error')) throw new Error('SIWC authorization failed');
    const code = params.get('code');
    const callbackClientId = params.get('client_id');
    const issuedClientId = this.options.clientId ?? this.options.provisionalClientId;
    const clientId = issuedClientId ?? callbackClientId;
    if (!code || !clientId || !clientId.trim() || clientId === 'dynamic_agent_client' || (issuedClientId && callbackClientId !== null && callbackClientId !== issuedClientId)) throw new Error('Invalid SIWC callback');
    const base = { code, clientId, redirectUri: this.options.redirectUri, nonce: this.authorization.nonce, verifier: this.authorization.verifier };
    return this.options.expectedIdentity ? { ...base, mode: 'returning' as const, expectedIdentity: { ...this.options.expectedIdentity } } : { ...base, mode: 'registration' as const };
  }
}

