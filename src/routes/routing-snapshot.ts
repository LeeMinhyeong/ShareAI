import { getDb } from '../db/client.js';
import { AccountRepository } from '../db/repositories/accounts.js';
import { accountPool } from '../account-pool/manager.js';
import { CredentialVault } from '../utils/encryption.js';
import { SiwcStore } from '../upstream/siwc-store.js';
import { decodeJwt, parseStoredCredentials } from '../upstream/oauth.js';
import { assert429V2Schema } from '../db/account-429-v2-store.js';

/** Administrative, advisory view only. The admission fence remains authoritative. */
export function routingSnapshot() {
  const db = getDb(), repo = new AccountRepository(), now = Date.now();
  const ordinary = repo.findAllAdmin();
  const candidates = new Set<string>();
  for (const provider of new Set(ordinary.map(a => a.provider))) {
    for (const a of repo.findActiveByProvider(provider)) {
      if (a.status === 'quota_exceeded' && a.quotaInfo?.resetAt && a.quotaInfo.resetAt > now) continue;
      if (provider === 'openai' && a.credentialType === 'oauth') {
        const c = parseStoredCredentials(a.credentials);
        if (!c || (c.refreshToken != null && typeof c.refreshToken !== 'string')) continue;
        const exp = decodeJwt(c.accessToken)?.exp;
        const jwtExpired = typeof exp === 'number' && Number.isFinite(exp) && exp * 1000 <= now;
        const expired = (c.expiresAt != null && c.expiresAt <= now) || jwtExpired;
        const refresh = !!c.refreshToken?.trim() && (jwtExpired || (!!c.expiresAt && c.expiresAt - now < 300000));
        if ((c.refreshToken && repo.hasRefreshIntent(provider,c.refreshToken)) || (expired && !refresh) || (!refresh && !/^[A-Za-z0-9._~+/-]+=*$/.test(c.accessToken)) || ((typeof c.accountId !== 'string' || !c.accountId.trim() || /[\x00-\x1f\x7f]/.test(c.accountId)) && !(refresh && (c.accountId == null || c.accountId === '')))) continue;
      }
      candidates.add(a.id);
    }
  }
  const hasSiwc = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get();
  const siwc = hasSiwc ? db.prepare('SELECT a.id, COALESCE(p.enabled,0) AS enabled FROM siwc_accounts a LEFT JOIN siwc_access_policy p ON p.account_id=a.id').all() as {id:string;enabled:number}[] : [];
  const store = siwc.length ? new SiwcStore(db, new CredentialVault(), {initialize:false}) : null;
  // Validate and read from the same SQLite snapshot. A bad schema or read is
  // unknown, never evidence that an account is unrestricted.
  let restrictions: Set<string> | null = null;
  try {
    restrictions = db.transaction(() => {
      assert429V2Schema(db);
      const entries = db.prepare('SELECT kind, account_id FROM main.account_429_v2_restrictions').all() as {kind:string;account_id:string}[];
      return new Set(entries.map(e => JSON.stringify([e.kind,e.account_id])));
    })();
  } catch { /* fail closed below */ }
  type State = 'open'|'restricted'|'cooldown_until'|'no_known_block'|'unavailable'|'unknown';
  const rows: {kind:'upstream'|'siwc';id:string;state:State;cooldown_until?:number}[] = [];
  function add(kind:'upstream'|'siwc', id:string, state:State, localUntil:number) {
    const table = kind === 'upstream' ? 'ordinary_account_attempts' : 'siwc_account_attempts';
    if (db.prepare(`SELECT 1 FROM main.${table} WHERE account_id=?`).get(id)) { rows.push({kind,id,state:'open'}); return; }
    if (!restrictions) { rows.push({kind,id,state:'unknown'}); return; }
    if (restrictions.has(JSON.stringify([kind,id]))) { rows.push({kind,id,state:'restricted'}); return; }
    if (!Number.isFinite(localUntil) || localUntil < 0 || localUntil > 8640000000000000) { rows.push({kind,id,state:'unknown'}); return; }
    const deadline = Math.ceil(localUntil);
    if (deadline > now) rows.push({kind,id,state:'cooldown_until',cooldown_until:deadline});
    else rows.push({kind,id,state});
  }
  for (const a of ordinary) {
    const quota = db.prepare('SELECT day,used,legacy_ambiguous FROM account_daily_reservations WHERE account_id=?').get(a.id) as {day:unknown;used:unknown;legacy_ambiguous:unknown} | undefined;
    const day = new Date(now).toISOString().slice(0,10);
    const validDay = (v:unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0,10) === v && v <= day;
    let state: State = candidates.has(a.id) ? 'no_known_block' : 'unavailable';
    if (!Number.isSafeInteger(a.dailyQuota) || a.dailyQuota < 0 || (quota && (!validDay(quota.day) || !Number.isSafeInteger(quota.used) || (quota.used as number) < 0 || ![0,1].includes(quota.legacy_ambiguous as number)))) state = 'unknown';
    else if (quota && quota.day === day && ((quota.used as number) >= Number.MAX_SAFE_INTEGER || (a.dailyQuota > 0 && (quota.legacy_ambiguous === 1 || (quota.used as number) >= a.dailyQuota)))) state = 'unavailable';
    add('upstream',a.id,state,accountPool.observedCooldown(a.id,a.stateRevision));
  }
  for (const a of siwc) {
    let state: State = 'unavailable', localUntil = 0;
    try {
      const snap = store!.readSnapshot(a.id);
      if (snap) {
        const c = snap.credential, local = accountPool.siwcFailureMarker(a.id);
        if (local?.revision === snap.revision) localUntil = local.cooldownUntil;
        const expiry = Date.parse(c.savedAt) + c.expiresIn * 1000;
        const expired = expiry <= now;
        if (!Number.isFinite(expiry) || Math.abs(expiry) > 8640000000000000) state = 'unknown';
        else if (a.enabled === 1 && c.scopes.includes('chatgpt.tokens.use.direct') && (!expired || (!!c.refreshToken && c.scopes.includes('offline_access') && (c.earliestRefreshAt === undefined || c.earliestRefreshAt * 1000 <= now) && !repo.hasRefreshIntent('openai',c.refreshToken)))) state = 'no_known_block';
      }
    } catch { state = 'unknown'; }
    add('siwc',a.id,state,localUntil);
  }
  return {as_of:new Date(now).toISOString(), note:'Global routing indicator only, not request eligibility. Actual requests may still be rejected due to ACL, model or options, quota, process-local state, concurrent changes or clock changes.', accounts:rows};
}
