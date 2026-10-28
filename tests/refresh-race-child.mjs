const { AccountRepository } = await import('../src/db/repositories/accounts.ts');
const { resolveAuth } = await import('../src/upstream/tokens.ts');
const account = new AccountRepository().findById(process.env.TEST_ACCOUNT_ID);
globalThis.fetch = async () => {
  process.send('fetch');
  const response = await new Promise(resolve => process.once('message', resolve));
  return response === 'failure'
    ? new Response('{"error":"invalid_grant"}', { status: 400 })
    : new Response('{"access_token":"rotated","refresh_token":"next","expires_in":3600}', { status: 200 });
};
try { await resolveAuth(account); process.send('success'); }
catch { process.send('failure'); }
process.disconnect();
