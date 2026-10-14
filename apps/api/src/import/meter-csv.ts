import { DEFAULT_TIME_ZONE, INTERVAL_MS, zonedToEpoch } from '@peak-guard/core';

/**
 * Tolerant parser for smart-meter portal CSV exports (Netz NÖ and similar Austrian
 * portals). The Netz NÖ format isn't publicly documented, so columns are detected from
 * the header: a timestamp (or separate date + time, or from/to columns) and a value in
 * kWh, Wh or kW per quarter-hour.
 */

export interface MeterRow {
  /** Local timestamp as parsed (epoch ms); interval start or end depending on alignment. */
  ts: number;
  /** Energy of the quarter-hour (Wh). */
  wh: number;
  /** Raw status/quality text if the file has such a column. */
  status: string | null;
}

export type Alignment = 'start' | 'end';

export interface ParsedMeterCsv {
  rows: MeterRow[];
  /** Known from explicit from/to columns, otherwise null (to be detected). */
  alignment: Alignment | null;
  columns: { time: string; value: string; unit: 'kWh' | 'Wh' | 'kW' };
  skipped: number;
  warnings: string[];
}

const TIME_HEADER =
  /(messzeitpunkt|zeitstempel|timestamp|datum|date|zeit|time|von|bis|from|to|beginn|ende|start|end)/i;
const FROM_HEADER = /(von|from|beginn|start)/i;
const TO_HEADER = /(bis|to\b|ende|end)/i;
const DATE_ONLY_HEADER = /^(datum|date|tag|day)$/i;
const VALUE_HEADER =
  /(kwh|wh\b|kw\b|verbrauch|bezug|wert|value|energie|energy|consumption|leistung)/i;
const STATUS_HEADER = /(status|ersatzwert|qualit|quality|flag)/i;

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(lines: string[]): string {
  const candidates = [';', '\t', ','];
  const score = (d: string) => lines.slice(0, 20).reduce((s, l) => s + (l.split(d).length - 1), 0);
  return candidates.reduce((best, d) => (score(d) > score(best) ? d : best), ';');
}

/** "1.234,56" / "1,234.56" / "0,125" / "0.125" → number */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/\s|\u00a0/g, '');
  if (s === '' || s === '-') return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/** Parse "dd.mm.yyyy[ hh:mm[:ss]]", "yyyy-mm-dd[T ]hh:mm[:ss]" or just a time "hh:mm". */
export function parseWallClock(raw: string): Partial<WallClock> | null {
  const s = raw.trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (m) return { d: +m[1]!, mo: +m[2]!, y: +m[3]!, ...(m[4] ? { h: +m[4], mi: +m[5]! } : {}) };
  m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
      s,
    );
  if (m) return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, ...(m[4] ? { h: +m[4], mi: +m[5]! } : {}) };
  m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return { h: +m[1]!, mi: +m[2]! };
  return null;
}

export function parseMeterCsv(text: string): ParsedMeterCsv {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('file has no data rows');
  const delimiter = detectDelimiter(lines);

  // Header: the first line with a time-like and a value-like column.
  let headerIdx = -1;
  let header: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitLine(lines[i]!, delimiter);
    if (
      cells.some((c) => TIME_HEADER.test(c)) &&
      cells.some((c) => VALUE_HEADER.test(c) && !TIME_HEADER.test(c) && !STATUS_HEADER.test(c))
    ) {
      headerIdx = i;
      header = cells;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('no header row with a time and an energy column found');

  const isValue = (c: string) =>
    VALUE_HEADER.test(c) && !TIME_HEADER.test(c) && !STATUS_HEADER.test(c);
  // Prefer a column that states a unit.
  const withUnit = header.findIndex((c) => isValue(c) && /k?wh?\b/i.test(c));
  const valueCol = withUnit >= 0 ? withUnit : header.findIndex(isValue);
  const statusCol = header.findIndex((c, i) => i !== valueCol && STATUS_HEADER.test(c));
  const timeCols = header
    .map((c, i) => (TIME_HEADER.test(c) && i !== valueCol ? i : -1))
    .filter((i) => i >= 0);
  const dateCol = timeCols.find((i) => DATE_ONLY_HEADER.test(header[i]!)) ?? -1;
  const fromCol = timeCols.find((i) => i !== dateCol && FROM_HEADER.test(header[i]!)) ?? -1;
  const toCol =
    timeCols.find((i) => i !== dateCol && i !== fromCol && TO_HEADER.test(header[i]!)) ?? -1;
  const tsCol =
    fromCol >= 0 ? fromCol : toCol >= 0 ? toCol : (timeCols.find((i) => i !== dateCol) ?? dateCol);
  const alignment: Alignment | null = fromCol >= 0 ? 'start' : toCol >= 0 ? 'end' : null;

  const valueHeader = header[valueCol]!;
  const unit: 'kWh' | 'Wh' | 'kW' = /kwh/i.test(valueHeader)
    ? 'kWh'
    : /\bwh\b/i.test(valueHeader)
      ? 'Wh'
      : /\bkw\b/i.test(valueHeader)
        ? 'kW'
        : 'kWh';
  const toWh = (v: number) =>
    unit === 'kWh' ? v * 1000 : unit === 'Wh' ? v : (v * 1000 * INTERVAL_MS) / 3_600_000;

  const rows: MeterRow[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let prevTs = -Infinity;
  let lastDate: Partial<WallClock> | null = null;

  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitLine(line, delimiter);
    const value = parseNumber(cells[valueCol] ?? '');
    let wall = parseWallClock(cells[tsCol] ?? '');
    if (dateCol >= 0 && dateCol !== tsCol) {
      const date = parseWallClock(cells[dateCol] ?? '');
      if (date?.y) lastDate = date;
      if (wall && wall.y == null && lastDate) wall = { ...lastDate, ...wall };
    }
    if (value == null || !wall || wall.y == null || wall.h == null) {
      skipped++;
      continue;
    }
    let ts = zonedToEpoch(wall.y, wall.mo!, wall.d!, wall.h, wall.mi, DEFAULT_TIME_ZONE);
    // "24:00" style end times
    if (wall.h === 24)
      ts = zonedToEpoch(wall.y, wall.mo!, wall.d! + 1, 0, wall.mi, DEFAULT_TIME_ZONE);
    // Repeated local hour at the end of DST: the second occurrence is one hour later.
    if (ts <= prevTs && prevTs - ts < 2 * 3_600_000) ts += 3_600_000;
    if (ts % INTERVAL_MS !== 0) {
      skipped++;
      continue;
    }
    prevTs = ts;
    rows.push({ ts, wh: toWh(value), status: statusCol >= 0 ? cells[statusCol] || null : null });
  }
  if (rows.length === 0) throw new Error('no valid quarter-hour rows found');
  if (skipped > 0) warnings.push(`${skipped} rows skipped (empty value or unparseable time)`);
  return {
    rows,
    alignment,
    columns: { time: header[tsCol]!, value: valueHeader, unit },
    skipped,
    warnings,
  };
}

/**
 * Decide whether single timestamps mark interval starts or ends by comparing both
 * interpretations with our own measurements (lower mean absolute difference wins).
 * Falls back to "end" (00:15 … 24:00) when there's no overlap, which is the common
 * convention of Austrian portals.
 */
export function detectAlignment(
  rows: readonly MeterRow[],
  own: ReadonlyMap<number, number>,
): Alignment {
  const score = (shift: number) => {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const o = own.get(r.ts + shift);
      if (o == null) continue;
      sum += Math.abs(o - r.wh);
      n++;
    }
    return n >= 8 ? sum / n : null;
  };
  const asStart = score(0);
  const asEnd = score(-INTERVAL_MS);
  if (asStart == null && asEnd == null) return 'end';
  if (asStart == null) return 'end';
  if (asEnd == null) return 'start';
  return asStart <= asEnd ? 'start' : 'end';
}

/** Interval starts for rows given an alignment. */
export function toIntervalStarts(rows: readonly MeterRow[], alignment: Alignment) {
  const shift = alignment === 'end' ? -INTERVAL_MS : 0;
  return rows.map((r) => ({ start: r.ts + shift, wh: r.wh, status: r.status }));
}
