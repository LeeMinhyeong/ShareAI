// HTTP recipients must accept the two obsolete wire formats as well as IMF-fixdate.
// Parse only the exact grammar and validate the weekday/calendar via UTC round-trip.
function parseHttpDate(value: string, reference: number): number | undefined {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
  let day: string, month: string, year: number, time: string, weekday: string;
  if (m) { [, weekday, day, month] = m; year = Number(m[4]); time = m[5]; }
  else {
    m = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
    if (m) {
      weekday = m[1].slice(0,3); day = m[2]; month = m[3]; time = m[5];
      const currentYear = new Date(reference).getUTCFullYear();
      if (!Number.isFinite(currentYear)) return undefined;
      year = Math.floor((currentYear + 50) / 100) * 100 + Number(m[4]);
      const tentative = Date.parse(`${weekday}, ${day} ${month} ${year} ${time.replace(/:60$/, ':59')} GMT`);
      const limit = new Date(reference); limit.setUTCFullYear(limit.getUTCFullYear() + 50);
      if (tentative > limit.getTime()) year -= 100;
    } else {
      m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(value);
      if (!m) return undefined;
      weekday = m[1]; month = m[2]; day = m[3].trim().padStart(2,'0'); time = m[4]; year = Number(m[5]);
    }
  }
  if (!days.includes(weekday) || !months.includes(month) || year < 1000 || year > 9999) return undefined;
  const leapSecond = time.endsWith(':60');
  const canonical = `${weekday}, ${day} ${month} ${year} ${leapSecond ? time.slice(0,-2) + '59' : time} GMT`;
  const timestamp = Date.parse(canonical);
  return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === canonical ? timestamp + (leapSecond ? 1000 : 0) : undefined;
}

// Unusable or excessive hints must not accidentally become a short cooldown.
// MAX_SAFE_INTEGER is an effectively indefinite deadline representable by SQLite
// and JavaScript; manual recovery is required for such restrictions.
// Client guidance only: without a provider Date an absolute hint is measured
// against the local clock. Persisted restrictions must use recovery429Duration.
export function ordinary429Deadline(now: number, hint: string | undefined, serverDate?: string): number {
  const indefinite = Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(now) || now < 0 || now > indefinite - 5000) return indefinite;
  const minimum = now + 5000;
  if (hint === undefined) return minimum;
  if (/^[0-9]+$/.test(hint)) {
    if (hint.length > 16) return indefinite;
    const seconds = Number(hint);
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor((indefinite - now) / 1000)) return indefinite;
    return Math.max(minimum, now + seconds * 1000);
  }
  const serverTime = serverDate === undefined ? undefined : parseHttpDate(serverDate, now);
  const timestamp = parseHttpDate(hint, serverTime ?? now);
  if (timestamp === undefined) return indefinite;
  // HTTP dates have one-second precision. Allow a full second of uncertainty
  // in the provider-relative interval rather than shortening its possible wait.
  // This does not make the persisted wall-clock deadline monotonic or establish
  // that the provider Date is trustworthy.
  const delay = Math.max(0, timestamp - now, serverTime === undefined ? 0 : timestamp - serverTime + 1000);
  if (!Number.isSafeInteger(delay) || delay > indefinite - now) return indefinite;
  return Math.max(minimum, now + delay);
}

// Persisted-restriction gate (ADR 0008). An absolute HTTP-date hint yields a
// finite duration only relative to a round-tripped IMF-fixdate provider Date;
// obsolete Date formats have ambiguous years and must not be guessed into an
// early recovery. The year range matches parseHttpDate's 1000-9999 bound so
// both agree on a trusted Date. null means unknown: block until recovery.
export function recovery429Duration(now: number, hint?: string, serverDate?: string): number | null {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) return null;
  if (hint !== undefined && !/^[0-9]+$/.test(hint)) {
    if (serverDate === undefined || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [1-9]\d{3} \d{2}:\d{2}:\d{2} GMT$/.test(serverDate)) return null;
    const parsed = Date.parse(serverDate);
    if (!Number.isSafeInteger(parsed) || new Date(parsed).toUTCString() !== serverDate) return null;
  }
  const deadline = ordinary429Deadline(now, hint, serverDate);
  if (deadline === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(deadline) || deadline < now) return null;
  const duration = deadline - now;
  return Number.isSafeInteger(duration) ? duration : null;
}
