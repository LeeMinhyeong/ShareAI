// Experimental read-only planning of supplied JSON only; no database conversion or migration.
// Cannot establish source completeness, SQLite raw bytes, schema, or production safety.
// observed_at, until_at and revision are validated but omitted from the proposal.
// Accept only inert JSON text, never a database, row objects, or callbacks.
export function planLegacy429(json) {
  if (arguments.length !== 1 || typeof json !== 'string') throw new TypeError('Expected one JSON string');
  const rows = JSON.parse(json);
  if (!Array.isArray(rows)) throw new TypeError('Expected an array of legacy rows');
  const seen = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== 'account_id,kind,observed_at,revision,until_at' ||
        !['siwc', 'upstream'].includes(row.kind) || typeof row.account_id !== 'string' ||
        !row.account_id.length || row.account_id.includes('\0') ||
        !row.account_id.isWellFormed() || Buffer.byteLength(row.account_id, 'utf8') > 512 ||
        !Number.isSafeInteger(row.observed_at) || !Number.isSafeInteger(row.until_at) ||
        !Number.isSafeInteger(row.revision) || row.revision <= 0) throw new TypeError('Malformed legacy row');
    const key = JSON.stringify([row.kind, row.account_id]);
    if (seen.has(key)) throw new Error('Duplicate legacy account key');
    seen.add(key);
    return {kind:row.kind, account_id:row.account_id, generation:index + 1, duration_ns:null};
  });
}
