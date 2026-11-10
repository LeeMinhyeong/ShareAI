// Savepoint wrapper used only by the disposable worker.
export function scenario(db, setup, check) {
  db.exec('SAVEPOINT extractor_case');
  let failed = false, primary, result;
  try {
    setup();
    result = check();
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    db.exec('ROLLBACK TO extractor_case');
    db.exec('RELEASE extractor_case');
  } catch (cleanupError) {
    if (failed) throw new AggregateError([primary, cleanupError], 'Scenario and cleanup failed');
    throw cleanupError;
  }
  if (failed) throw primary;
  return result;
}
