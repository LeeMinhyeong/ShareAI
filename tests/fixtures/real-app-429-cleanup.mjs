// Test fixture cleanup: never remove files unless close and cwd restoration succeeded.
export function cleanupFixture({close, restore, remove, dir, failed, primary}) {
  const cleanupErrors = [];
  let closed = !close;
  if (close) {
    try { close(); closed = true; } catch (error) { cleanupErrors.push(error); }
  }
  let restored = false;
  try { restore(); restored = true; } catch (error) { cleanupErrors.push(error); }
  if (closed && restored) {
    try { remove(); } catch (error) { cleanupErrors.push(error); }
  } else {
    cleanupErrors.push(new Error(`Fixture retained: ${dir}`));
  }
  if (failed || cleanupErrors.length) {
    if (failed && !cleanupErrors.length) throw primary;
    throw new AggregateError([...(failed ? [primary] : []), ...cleanupErrors], 'Fixture or cleanup failed');
  }
}
