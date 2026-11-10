import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getDb } from '../db/client.js';
import { withAsyncWriter } from '../db/async-writer.js';
import { CredentialVault } from '../utils/encryption.js';
import { getSiwcHostId, SiwcAttempt } from './siwc-session.js';
import { exchangeSiwcCode, SiwcInvalidGrantError } from './siwc.js';
import { SiwcStore } from './siwc-store.js';

type Flow = { id: string; name: string; state: string; attempt: SiwcAttempt; server: Server; status: 'pending' | 'exchanging' | 'complete' | 'failed'; accountId?: string; selectedId?: string; selected?: NonNullable<ReturnType<SiwcStore['readRegistrationSnapshot']>>; provisionalClientId?: string; finished: boolean; expiresAt: number; timer: ReturnType<typeof setTimeout> };
const flows = new Map<string, Flow>();
const active = new Set<Promise<unknown>>();
const listeners = new Map<Server, { close?: Promise<void>; starting: boolean }>();
let stopping = false;
let stopPromise: Promise<void> | undefined;

// Publish ownership before invoking code which can synchronously reenter shutdown.
function track<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const work = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  active.add(work);
  void work.then(() => active.delete(work), () => active.delete(work));
  try { resolve(fn()); } catch (error) { reject(error); }
  return work;
}

function closeServer(server: Server): Promise<void> {
  const owner = listeners.get(server);
  if (!owner) return Promise.resolve();
  if (owner.close) return owner.close;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  owner.close = promise;
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    server.removeListener('error', onError);
    // Node reports ERR_SERVER_NOT_RUNNING when no handle was ever bound (or it
    // was already released); such a server owns no socket. Any other error, or
    // a server still reporting listening, remains retained for an explicit retry.
    const released = (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING' && !server.listening;
    if (error && !released) { owner.close = undefined; reject(error); }
    else { listeners.delete(server); resolve(); }
  };
  const onError = (error: Error) => finish(error || new Error('Listener error'));
  try { server.on('error', onError); server.close(finish); } catch (error) { finish(error instanceof Error ? error : new Error('Listener close failed')); }
  return promise;
}

function response(res: import('node:http').ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
  res.end(text);
}
function close(flow: Flow) { void closeServer(flow.server).catch(() => { /* retained for an explicit shutdown retry */ }); }
async function handle(flow: Flow, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const address = flow.server.address();
  if (!address || typeof address === 'string' || req.method !== 'GET' || req.headers.host !== `127.0.0.1:${address.port}`) return response(res, 400, 'Invalid callback');
  let params: URLSearchParams;
  try { const u = new URL(req.url ?? '', `http://127.0.0.1:${address.port}`); if (u.pathname !== '/auth/callback') throw new Error(); params = u.searchParams; } catch { return response(res, 400, 'Invalid callback'); }
  if (flow.status !== 'pending' || params.getAll('state').length !== 1 || params.get('state') !== flow.state) return response(res, 400, 'Invalid callback');
  let attempt: ReturnType<SiwcAttempt['consume']>;
  try { attempt = flow.attempt.consume(params); } catch { flow.status = 'failed'; close(flow); return response(res, 400, 'Authorization failed'); }
  flow.status = 'exchanging';
  close(flow);
  try {
    const store = new SiwcStore(getDb(), new CredentialVault());
    const authorizationIntent = flow.selectedId && flow.selected ? store.claimAuthorization(flow.selectedId, flow.selected.revision) : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      let credential: Awaited<ReturnType<typeof exchangeSiwcCode>>;
      try {
        credential = await exchangeSiwcCode(attempt, (input, init) => fetch(input, { ...init, signal: controller.signal }));
      } catch (error) {
        // Only an explicit provider refusal proves this exchange issued no token.
        if (error instanceof SiwcInvalidGrantError && error.definitiveRefusal && !controller.signal.aborted && flow.selectedId && authorizationIntent) store.finishAuthorization(flow.selectedId, authorizationIntent);
        throw error;
      }
      if (controller.signal.aborted || stopping || Date.now() >= flow.expiresAt || flows.get(flow.id) !== flow || flow.status !== 'exchanging') throw new Error();
      const db = getDb();
      const accountId = flow.selectedId ?? randomUUID();
      db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS siwc_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
        if (flow.selectedId && flow.selected) {
          const current = store.readRegistrationSnapshot(accountId);
          if (!current || current.revision !== flow.selected.revision || (current.credential?.refreshToken && !credential.refreshToken)) throw new Error('Credentials changed or renewable session missing');
          store.replace(accountId, credential);
          store.finishAuthorization(accountId, authorizationIntent!);
        } else {
          db.prepare('INSERT INTO siwc_accounts (id, name) VALUES (?, ?)').run(accountId, flow.name);
          store.create(accountId, credential);
        }
      }).immediate();
      flow.accountId = accountId; flow.status = 'complete';
      response(res, 200, 'Sign-in complete. You may close this window.');
    } finally { clearTimeout(timeout); }
  } catch (error) { if (error instanceof SiwcInvalidGrantError && !flow.selectedId && !stopping) flow.provisionalClientId = error.clientId; flow.status = 'failed'; response(res, 400, 'Sign-in failed. Start a new attempt.'); }
}

export const noStoreSiwc: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

async function revokeSession(credential: { refreshToken?: string; clientId: string }): Promise<boolean> {
  if (!credential.refreshToken) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      const discovery = await fetch('https://auth.openai.com/.well-known/openid-configuration', { redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
      if (controller.signal.aborted || discovery.status !== 200 || discovery.redirected) return false;
      const metadata = await discovery.json() as { revocation_endpoint?: unknown };
      if (controller.signal.aborted || typeof metadata.revocation_endpoint !== 'string') return false;
      const endpoint = new URL(metadata.revocation_endpoint);
      if (endpoint.origin !== 'https://auth.openai.com' || endpoint.username || endpoint.password || endpoint.hash) return false;
      const result = await fetch(endpoint.href, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credential.refreshToken!, token_type_hint: 'refresh_token', client_id: credential.clientId }) });
      return result.status === 200 && !result.redirected;
    };
    const deadline = new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 5000); });
    return await Promise.race([work(), deadline]);
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

export function createSiwcRouter(authenticateAdmin: RequestHandler) {
  const router = Router();
  router.use(noStoreSiwc, authenticateAdmin);
  // These handlers perform synchronous DB work and do not dispatch or detach
  // continuations. Register before invoking them, including response calls.
  const ownedSync = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    if (stopping) {
      try { return res.status(503).json({ error: { message: 'Sign-in unavailable' } }); }
      catch { try { res.destroy(); } catch { /* best effort */ } return; }
    }
    return track(() => {
      try { return handler(req, res, next); }
      catch (error) { return next(error); }
    });
  };
  router.post('/start', (req, res) => {
    if (stopping) return res.status(400).json({ error: { message: 'Invalid request' } });
    return track(async () => {
    const body = req.body;
    const isNew = body && typeof body.name === 'string' && !!body.name.trim() && body.name.length <= 200 && Object.keys(body).length === 1;
    const isReturning = body && typeof body.accountId === 'string' && !!body.accountId.trim() && Object.keys(body).length === 1;
    const isRetry = body && typeof body.retryFlowId === 'string' && !!body.retryFlowId.trim() && Object.keys(body).length === 1;
    const prior = isRetry ? flows.get(body.retryFlowId) : undefined;
    if (stopping || (!isNew && !isReturning && !isRetry) || (isRetry && (!prior || prior.status !== 'failed' || !prior.provisionalClientId))) return res.status(400).json({ error: { message: 'Invalid request' } });
    if (flows.size >= 32) return res.status(503).json({ error: { message: 'Too many sign-in attempts' } });
    const provisionalClientId = prior?.provisionalClientId;
    if (prior) prior.provisionalClientId = undefined;
    const server = createServer();
    // Keep an error guard for the lifetime of an owned, possibly uncertain listener.
    server.on('error', () => {});
    const owner = { starting: true };
    listeners.set(server, owner);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      owner.starting = false;
      const address = server.address(); if (!address || typeof address === 'string' || stopping) throw new Error();
      let selected: Flow['selected'];
      if (isReturning) {
        const db = getDb();
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'siwc_accounts'").get() || !db.prepare('SELECT 1 FROM siwc_accounts WHERE id = ?').get(body.accountId)) throw new Error();
        selected = new SiwcStore(db, new CredentialVault()).readRegistrationSnapshot(body.accountId) ?? undefined;
        if (!selected) throw new Error();
      }
      const credential = selected?.credential;
      const attempt = new SiwcAttempt({ hostId: getSiwcHostId(getDb()), redirectUri: `http://127.0.0.1:${address.port}/auth/callback`, ...(selected ? { clientId: selected.identity.clientId, expectedIdentity: selected.identity, ...(credential ? { idTokenHint: credential.idToken } : {}) } : provisionalClientId ? { provisionalClientId } : {}) });
      const id = randomUUID();
      const flow: Flow = { id, name: isNew ? body.name.trim() : prior?.name ?? '', selectedId: isReturning ? body.accountId : undefined, selected, attempt, state: new URL(attempt.url).searchParams.get('state')!, server, status: 'pending', finished: false, expiresAt: Date.now() + 600000, timer: setTimeout(() => { if (flow.status === 'pending' || flow.status === 'exchanging') flow.status = 'failed'; close(flow); flows.delete(id); }, 600000) };
      flow.timer.unref();
      flows.set(id, flow);
      server.on('request', (request, response_) => {
        if (stopping) { response(response_, 503, 'Sign-in unavailable'); return; }
        void track(() => handle(flow, request, response_)).catch(() => { /* request already owns its failure */ });
      });
      return res.json({ flowId: id, authorizationUrl: attempt.url });
    } catch { owner.starting = false; if (prior && provisionalClientId) prior.provisionalClientId = provisionalClientId; if (!stopping) void closeServer(server).catch(() => {}); return res.status(500).json({ error: { message: 'Could not start sign-in' } }); }
    });
  });
  router.get('/accounts', ownedSync((_req, res) => {
    try {
      const db = getDb();
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'siwc_accounts'").get();
      return res.json({ accounts: exists ? db.prepare('SELECT id, name FROM siwc_accounts ORDER BY name, id').all() : [] });
    } catch { return res.status(500).json({ error: { message: 'Could not list accounts' } }); }
  }));
  router.get('/accounts/:id/routing', ownedSync((req, res) => {
    try {
      const db = getDb();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get() || !db.prepare('SELECT 1 FROM siwc_accounts WHERE id=?').get(req.params.id)) return res.sendStatus(404);
      const settings = db.prepare('SELECT priority, weight FROM siwc_routing_settings WHERE account_id=?').get(req.params.id);
      return res.json(settings ?? {priority:0, weight:1});
    } catch { return res.status(500).json({error:{message:'Could not read routing settings'}}); }
  }));
  router.post('/accounts/:id/routing', ownedSync((req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'priority,weight' || !Number.isInteger(body.priority) || body.priority < 0 || body.priority > 1000 || !Number.isInteger(body.weight) || body.weight < 1 || body.weight > 100) return res.status(400).json({error:{message:'Invalid routing settings'}});
    try {
      const db = getDb();
      const updated = db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get() || !db.prepare('SELECT 1 FROM siwc_accounts WHERE id=?').get(req.params.id)) return false;
        db.prepare('INSERT INTO siwc_routing_settings(account_id,priority,weight) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET priority=excluded.priority,weight=excluded.weight').run(req.params.id,body.priority,body.weight);
        return true;
      }).immediate();
      if (!updated) return res.sendStatus(404);
      return res.json({priority:body.priority,weight:body.weight});
    } catch { return res.status(500).json({error:{message:'Could not update routing settings'}}); }
  }));
  router.post('/accounts/:id/logout', (req, res) => {
    if (stopping) return res.status(503).json({ error: { message: 'Sign-in unavailable' } });
    // Logout can resume after its first writer and the remote revocation.
    // Register its entire promise before starting either operation so stopSiwc
    // retains ownership through the final DB verification and response.
    return track(async () => {
    let result: ReturnType<SiwcStore['logout']>;
    try {
      const outcome = await withAsyncWriter(db => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get() || !db.prepare('SELECT 1 FROM siwc_accounts WHERE id=?').get(req.params.id)) return { kind: 'missing' as const };
        const store = new SiwcStore(db, new CredentialVault(), { initialize: false });
        if (!store.read(req.params.id)) return { kind: 'unavailable' as const };
        return { kind: 'signed-out' as const, result: store.logout(req.params.id) };
      });
      if (outcome.kind === 'missing') return res.sendStatus(404);
      if (outcome.kind === 'unavailable') return res.status(409).json({ error: { message: 'Session unavailable' } });
      result = outcome.result;
    } catch { return res.status(500).json({ error: { message: 'Could not sign out locally' } }); }
    const revoked = await revokeSession(result.credential);
    let stillCertain = false;
    try {
      const verification = await withAsyncWriter(db => {
        const store = new SiwcStore(db, new CredentialVault(), { initialize: false });
        let certain = false;
        try { certain = store.logoutStillCertain(req.params.id, result.revision); } catch { /* fail closed */ }
        const current = store.readRegistrationSnapshot(req.params.id);
        return { certain, changed: !current || !!current.credential || current.revision !== result.revision };
      });
      if (verification.changed) return res.status(409).json({ error: { message: 'Session changed during sign out' } });
      stillCertain = verification.certain;
    } catch { return res.status(500).json({ error: { message: 'Could not verify local sign out' } }); }
    return res.json({ localSignedOut: true, remoteRevoked: revoked && !result.remoteUncertain && stillCertain });
    });
  });
  router.get('/accounts/:id/access', ownedSync((req, res) => {
    try {
      const db = getDb();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get() || !db.prepare('SELECT 1 FROM siwc_accounts WHERE id=?').get(req.params.id)) return res.sendStatus(404);
      const policy = db.prepare('SELECT enabled, scope FROM siwc_access_policy WHERE account_id=?').get(req.params.id) as {enabled:number; scope:string} | undefined;
      const userIds = (db.prepare('SELECT user_id FROM siwc_access_users WHERE account_id=? ORDER BY user_id').all(req.params.id) as {user_id:string}[]).map(row => row.user_id);
      return res.json({enabled: policy?.enabled === 1, scope: policy?.scope ?? 'selected', userIds});
    } catch { return res.status(500).json({error:{message:'Could not read access policy'}}); }
  }));
  router.post('/accounts/:id/access', ownedSync((req, res) => {
    const body = req.body;
    if (!body || Object.keys(body).sort().join(',') !== 'enabled,scope,userIds' || typeof body.enabled !== 'boolean' || !['all','selected'].includes(body.scope) || !Array.isArray(body.userIds) || body.userIds.length > 1000 || body.userIds.some((id: unknown) => typeof id !== 'string' || !id.trim()) || new Set(body.userIds).size !== body.userIds.length || (body.scope === 'all' && body.userIds.length)) return res.status(400).json({error:{message:'Invalid access policy'}});
    try {
      const db = getDb();
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='siwc_accounts'").get() || !db.prepare('SELECT 1 FROM siwc_accounts WHERE id=?').get(req.params.id)) return res.sendStatus(404);
      const found = db.prepare('SELECT 1 FROM users WHERE id=?');
      if (body.userIds.some((id: string) => !found.get(id))) return res.status(400).json({error:{message:'Unknown user'}});
      db.transaction(() => {
        db.prepare('INSERT INTO siwc_access_policy(account_id,enabled,scope) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET enabled=excluded.enabled,scope=excluded.scope').run(req.params.id, body.enabled ? 1 : 0, body.scope);
        db.prepare('DELETE FROM siwc_access_users WHERE account_id=?').run(req.params.id);
        const insert = db.prepare('INSERT INTO siwc_access_users(account_id,user_id) VALUES (?,?)');
        for (const id of body.userIds) insert.run(req.params.id, id);
      }).immediate();
      return res.json({enabled:body.enabled,scope:body.scope,userIds:body.userIds});
    } catch { return res.status(500).json({error:{message:'Could not update access policy'}}); }
  }));
  router.post('/:id/cancel', (req, res) => {
    const flow = flows.get(req.params.id);
    if (!flow || (flow.status !== 'pending' && flow.status !== 'exchanging')) return res.status(409).json({ error: { message: 'Sign-in cannot be cancelled' } });
    flow.status = 'failed'; clearTimeout(flow.timer); close(flow); flows.delete(flow.id);
    return res.json({ cancelled: true });
  });
  router.get('/:id', (req, res) => { const flow = flows.get(req.params.id); if (!flow) return res.status(404).json({ error: { message: 'Sign-in not found' } }); return res.json({ status: flow.status, ...(flow.provisionalClientId ? { retryable: true } : {}), ...(flow.accountId ? { accountId: flow.accountId } : {}) }); });
  router.post('/:id/finish', (req, res) => { const flow = flows.get(req.params.id); if (!flow || flow.finished || flow.status !== 'complete' || !flow.accountId) return res.status(400).json({ error: { message: 'Sign-in not complete' } }); flow.finished = true; return res.json({ accountId: flow.accountId }); });
  return router;
}

export function stopSiwc(): Promise<void> {
  if (stopPromise) return stopPromise;
  stopping = true;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const published = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  stopPromise = published;
  const run = async () => {
    for (const flow of flows.values()) clearTimeout(flow.timer);
    const attempted = new Set<Server>();
    const closing: Promise<void>[] = [];
    const closeReady = () => {
      for (const [server, owner] of listeners) {
        if (!owner.starting && !attempted.has(server)) {
          attempted.add(server);
          const work = closeServer(server);
          void work.catch(() => {});
          closing.push(work);
        }
      }
    };
    closeReady();
    // Observe close failures immediately even while admitted work is draining.
    const firstClosures = Promise.allSettled(closing);
    await Promise.allSettled([...active]);
    closeReady();
    await firstClosures;
    const results = await Promise.allSettled(closing);
    if (results.some(result => result.status === 'rejected') || listeners.size) throw new Error('SIWC listener closure unconfirmed');
    // A timed-out attempt must not tear down state owned by a later retry.
    if (stopPromise !== published) throw new Error('SIWC shutdown superseded');
    flows.clear();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Independent caller guard; server shutdown's 5s force-exit timer wins there.
  const deadline = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('SIWC shutdown timed out')), 15000); });
  void Promise.race([run(), deadline]).then(() => { if (timer) clearTimeout(timer); resolve(); }, error => { if (timer) clearTimeout(timer); if (stopPromise === published) stopPromise = undefined; reject(error); });
  return published;
}
