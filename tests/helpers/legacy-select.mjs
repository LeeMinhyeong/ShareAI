// forwardChat selects through accountPool.selectCandidate. Older tests stub the
// legacy accountPool.selectAccount to choose (and mutate) the account under test.
// This adapter routes selectCandidate through such a stub, wrapping the account
// as an upstream candidate; while selectAccount is not stubbed, real selection runs.
export function adaptLegacySelect(pool) {
  if (pool.__legacySelectAdapted) return;
  const realSelectAccount = pool.selectAccount;
  const realSelectCandidate = pool.selectCandidate.bind(pool);
  pool.selectCandidate = async (...args) => {
    if (pool.selectAccount === realSelectAccount) return realSelectCandidate(...args);
    const account = await pool.selectAccount(...args);
    return account ? {kind:'upstream', id:account.id, priority:account.priority, weight:account.weight, usedToday:account.usedToday, account} : null;
  };
  pool.__legacySelectAdapted = true;
}
