import http from 'node:http';
import { once } from 'node:events';
Object.assign(process.env, { PORT: '1', HOST: '127.0.0.1', NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ENCRYPTION_KEY: 'a'.repeat(64), ADMIN_API_KEY: 'x'.repeat(20), LOG_PRETTY: 'false', CORS_ORIGIN: 'https://example.test' });
const { default: v1 } = await import('../src/routes/v1.ts');
v1.post('/test-db-body', (_req, res) => {
  import('../src/db/client.ts').then(({ getDb }) => {
    getDb().prepare('SELECT 1').get();
    res.json({ database: 'open' });
  }).catch(() => res.status(500).end());
});
v1.get('/test-refresh', async (req, res) => {
  const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
  const { resolveAuth } = await import('../src/upstream/tokens.ts');
  const repo = new AccountRepository();
  const account = repo.create({ name: 'test-refresh', provider: 'openai', credentialType: 'oauth', credentials: JSON.stringify({ kind: 'oauth', accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1 }) });
  globalThis.fetch = async () => {
    process.send?.({ refresh: 'started' });
    await new Promise(resolve => setTimeout(resolve, req.query.stall ? 7000 : 700));
    return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }), { status: 200 });
  };
  if (req.query.late) {
    process.send?.({ refresh: 'waiting' });
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  try {
    await resolveAuth(account);
    console.log('REFRESH_SAVED:' + JSON.parse(repo.findById(account.id).credentials).refreshToken);
  } catch (e) { console.log('REFRESH_ERROR:' + e.message); }
  res.end();
});
v1.get('/test-delayed-db', async (_req, res) => {
  process.send?.({ handler: 'started' });
  await new Promise(resolve => setTimeout(resolve, 600));
  try {
    const { getDb } = await import('../src/db/client.ts');
    getDb();
    console.log('DELAYED_DB_REOPENED');
  } catch { console.log('DELAYED_DB_CLOSED'); }
  res.end();
});
const originalListen = http.Server.prototype.listen;
let mainServer;
http.Server.prototype.listen = function (...args) {
  if (args[0] === 1) { args[0] = 0; mainServer = this; }
  return originalListen.apply(this, args);
};
try { await import('../src/server.ts'); } finally { http.Server.prototype.listen = originalListen; }
if (!mainServer.listening) await once(mainServer, 'listening');
const port = mainServer.address().port;
process.on('message', async message => {
  if (message === 'oauth') {
    const http = await import('node:http');
    const listen = http.Server.prototype.listen;
    let callbackServer;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 1455) { args[0] = 0; callbackServer = this; }
      return listen.apply(this, args);
    };
    try {
      const { startLogin } = await import('../src/upstream/oauth.ts');
      const result = await startLogin('openai', { name: 'test' });
      process.send({ oauthPort: callbackServer?.address()?.port, listening: result.callbackListening });
    } finally { http.Server.prototype.listen = listen; }
  }
  if (message === 'oauth-concurrent') {
    const listen = http.Server.prototype.listen;
    let callbackServer;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 1455) { args[0] = 0; callbackServer = this; }
      return listen.apply(this, args);
    };
    try {
      const { startLogin, finishLogin, setOnLoginComplete } = await import('../src/upstream/oauth.ts');
      const flow = await startLogin('openai', { name: 'test' });
      const state = new URL(flow.authUrl).searchParams.get('state');
      let release, count = 0, saves = 0;
      const gate = new Promise(resolve => { release = resolve; });
      setOnLoginComplete(async () => { saves++; return 'account'; });
      globalThis.fetch = async () => { count++; process.send({ exchange: 'started' }); await gate; return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }); };
      process.on('message', async msg => {
        if (msg === 'oauth-manual') {
          let rejected = false;
          try { await finishLogin(flow.flowId, `http://localhost:1455/auth/callback?code=test&state=${state}`); } catch { rejected = true; }
          release();
          setTimeout(() => process.send({ rejected, count, saves }), 100);
        }
      });
      process.send({ oauthPort: callbackServer.address().port, state });
    } finally { http.Server.prototype.listen = listen; }
  }
  if (message === 'oauth-hang') {
    const listen = http.Server.prototype.listen;
    let callbackServer;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 1455) { args[0] = 0; callbackServer = this; }
      return listen.apply(this, args);
    };
    try {
      const { startLogin } = await import('../src/upstream/oauth.ts');
      const flow = await startLogin('openai', { name: 'test' });
      globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
        process.send({ exchange: 'started' });
        const timer = setTimeout(() => reject(new Error('timeout')), 7000);
        opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      process.send({ oauthPort: callbackServer.address().port, state: new URL(flow.authUrl).searchParams.get('state') });
    } finally { http.Server.prototype.listen = listen; }
  }
  if (message === 'oauth-race') {
    const listen = http.Server.prototype.listen;
    let callbackPort, callbackServer;
    http.Server.prototype.listen = function (...args) {
      if (args[0] === 1455) { args[0] = callbackPort ?? 0; callbackServer = this; }
      return listen.apply(this, args);
    };
    const close = http.Server.prototype.close;
    http.Server.prototype.close = function (...args) {
      if (this.address()?.port === callbackPort) { const server = this; setTimeout(() => close.apply(server, args), 250); return this; }
      return close.apply(this, args);
    };
    const oldFetch = globalThis.fetch;
    try {
      const { startLogin, finishLogin, setOnLoginComplete } = await import('../src/upstream/oauth.ts');
      const first = await startLogin('openai', { name: 'first' });
      callbackPort = callbackServer.address().port;
      setOnLoginComplete(async () => 'test-account');
      globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'test' }), { status: 200 });
      const state = new URL(first.authUrl).searchParams.get('state');
      await finishLogin(first.flowId, `http://localhost:1455/auth/callback?code=test&state=${state}`);
      const second = await startLogin('openai', { name: 'second' });
      process.send({ relistening: second.callbackListening });
    } finally { http.Server.prototype.listen = listen; http.Server.prototype.close = close; globalThis.fetch = oldFetch; }
  }
  if (message === 'keepalive') { setTimeout(() => console.log('KEEPALIVE_DONE'), 5500); process.send({ keepalive: true }); }
  if (message === 'shutdown') { process.emit('SIGTERM'); process.disconnect(); }
});
process.send({ port });
