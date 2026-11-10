export type RetryDuration = { kind: 'finite'; nanoseconds: bigint } | { kind: 'indefinite' };
export type RetryMetadata = { retryAfter?: string | readonly string[]; date?: string | readonly string[] };

const NS_PER_SECOND = 1_000_000_000n;
const MINIMUM = 5n;
const MAX_SECONDS = ((1n << 63n) - 1n) / NS_PER_SECOND;
const indefinite = (): RetryDuration => ({ kind: 'indefinite' });
const finite = (seconds: bigint): RetryDuration => seconds > MAX_SECONDS
  ? indefinite()
  : { kind: 'finite', nanoseconds: (seconds < MINIMUM ? MINIMUM : seconds) * NS_PER_SECOND };

// This deliberately duplicates the private strict HTTP-date grammar in
// forward-chat.ts rather than importing production routing and its side effects.
// RFC 850 needs a reference year; a two-digit provider Date itself has no
// trustworthy century without a wall clock, so it is rejected as ambiguous.
function parseHttpDate(value: string, reference?: number): number | undefined {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // Explicit absolute end: no trailing characters, even line terminators.
  const imf = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT(?![\s\S])/.exec(value);
  const rfc = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT(?![\s\S])/.exec(value);
  const asc = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}:\d{2}:\d{2}) (\d{4})(?![\s\S])/.exec(value);
  let weekday: string, day: number, month: number, year: number, time: string;
  if (imf) { weekday = imf[1]; day = Number(imf[2]); month = months.indexOf(imf[3]); year = Number(imf[4]); time = imf[5]; }
  else if (rfc && reference !== undefined) {
    weekday = rfc[1].slice(0, 3); day = Number(rfc[2]); month = months.indexOf(rfc[3]); time = rfc[5];
    const ref = new Date(reference);
    year = Math.floor((ref.getUTCFullYear() + 50) / 100) * 100 + Number(rfc[4]);
    const limit = new Date(reference); limit.setUTCFullYear(limit.getUTCFullYear() + 50);
    const tentative = Date.UTC(year, month, day, ...time.split(':').map(Number) as [number, number, number]);
    if (tentative > limit.getTime()) year -= 100;
  } else if (asc) { weekday = asc[1]; month = months.indexOf(asc[2]); day = Number(asc[3]); time = asc[4]; year = Number(asc[5]); }
  else return undefined;
  if (year < 1000 || year > 9999) return undefined;
  const [hours, minutes, seconds] = time.split(':').map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined; // no leap-second guessing
  const timestamp = Date.UTC(year, month, day, hours, minutes, seconds);
  const result = new Date(timestamp);
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month || result.getUTCDate() !== day || days[result.getUTCDay()] !== weekday) return undefined;
  return timestamp;
}

/**
 * Pure derivation, not wired into production. For an HTTP date, both fields
 * must originate in the same trusted provider response over its TLS connection.
 * The combined quantization error of the two dates must not exceed one second;
 * the extra second does not cover arbitrary clock error or intermediaries.
 * Multiple field values must be passed as arrays and are rejected, never joined.
 */
export function deriveRetryDuration(input: RetryMetadata): RetryDuration {
  const hint = input.retryAfter;
  if (hint === undefined) return finite(MINIMUM);
  if (typeof hint !== 'string' || hint.length > 8192) return indefinite();
  if (/^[0-9]+(?![\s\S])/.test(hint)) {
    const significant = hint.replace(/^0+/, '');
    // Avoid constructing BigInts for values already known to exceed the bound.
    if (significant.length > MAX_SECONDS.toString().length) return indefinite();
    return finite(BigInt(significant || '0'));
  }
  if (hint.length > 128) return indefinite();
  if (typeof input.date !== 'string' || input.date.length > 128) return indefinite();
  const base = parseHttpDate(input.date);
  if (base === undefined) return indefinite();
  const target = parseHttpDate(hint, base);
  if (target === undefined || target < base) return indefinite();
  // Both fields have second resolution; conservatively cover quantization.
  return finite((BigInt(target - base) + 999n) / 1000n + 1n);
}
