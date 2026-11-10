/** Parse only the two supported UTC storage formats, without normalization. */
export function parseUsageUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const canonical = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + '.000Z' : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(canonical)) return null;
  const ms = Date.parse(canonical);
  return Number.isFinite(ms) && new Date(ms).toISOString() === canonical ? ms : null;
}
