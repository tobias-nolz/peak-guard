/** Minimal RFC 4180 CSV writer. */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const cell = (v: unknown): string => {
    if (v == null) return '';
    const s =
      typeof v === 'number'
        ? Number.isFinite(v)
          ? String(v)
          : ''
        : typeof v === 'string'
          ? v
          : typeof v === 'boolean' || typeof v === 'bigint'
            ? String(v)
            : JSON.stringify(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD HH:MM:SS" in the given zone (sv-SE formats ISO-like). */
export function localTimestamp(ts: number, timeZone: string): string {
  let f = localFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    localFormatters.set(timeZone, f);
  }
  return f.format(ts);
}
