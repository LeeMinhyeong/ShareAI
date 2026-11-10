import type Database from 'better-sqlite3';

// Preserve literal SQLite TEXT IDs, including whitespace and controls, except NUL.
// Reject lone surrogates: the UTF-8 binding would silently replace them.
export function validExperimentalAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.from(value, 'utf8').toString('utf8') === value;
}

// SQLite permits malformed UTF-8 through direct SQL. Do not let the driver's
// replacement decoding alias a different primary key or hide an invalid row.
export function assertExperimentalAccountIds(db: Database.Database): void {
  for (const row of db.prepare('SELECT account_id, hex(CAST(account_id AS BLOB)) AS bytes FROM main.experimental_atomic_429_restrictions').iterate() as Iterable<{account_id: unknown; bytes: string}>) {
    if (!validExperimentalAccountId(row.account_id) || Buffer.from(row.account_id, 'utf8').toString('hex').toUpperCase() !== row.bytes) {
      throw new Error('Invalid restriction state');
    }
  }
}
