import { initDatabase, closeDatabase } from './client.js';

let initializationFailed = false;
let initializationError: unknown;
try {
  initDatabase();
} catch (error) {
  initializationFailed = true;
  initializationError = error;
}
try {
  closeDatabase();
} catch (cleanupError) {
  if (initializationFailed) throw new AggregateError([initializationError, cleanupError], 'Database initialization and cleanup failed');
  throw cleanupError;
}
if (initializationFailed) throw initializationError;
