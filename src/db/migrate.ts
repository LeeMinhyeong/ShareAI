import { initDatabase, closeDatabase } from './client.js';

try {
  initDatabase();
} finally {
  closeDatabase();
}
