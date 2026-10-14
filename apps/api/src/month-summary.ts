import {
  billable,
  billedKw,
  dayKey,
  localParts,
  monthlyCost,
  tariffFor,
  topN,
  zonedToEpoch,
  type ClosedInterval,
} from '@peak-guard/core';
import type { Settings } from '@peak-guard/shared';

export interface MonthSummary {
  month: string;
  peak: { start: number; kw: number } | null;
  billedKw: number;
  costEur: number;
  tariffId: string;
  top: { start: number; kw: number; maxImportKw: number | null; quality: string }[];
  daily: { day: string; peakKw: number | null; peakStart: number | null; importKwh: number }[];
  quality: Record<string, number>;
  intervalCount: number;
}

/** Monthly analysis of closed intervals (pure). kW values include the calibration factor. */
export function summarizeMonth(
  month: string,
  rows: readonly ClosedInterval[],
  settings: Settings,
  timeZone: string,
  topCount = 10,
): MonthSummary {
  const cal = settings.calibrationFactor;
  const calibrated = billable(rows).map((r) => ({ ...r, avgImportKw: r.avgImportKw * cal }));
  const tariff = tariffFor(`${month}-01`, settings.tariffs);
  const top = topN(calibrated, topCount);
  const peak = top[0] ? { start: top[0].start, kw: top[0].avgImportKw } : null;

  const days = new Map<string, MonthSummary['daily'][number]>();
  for (const r of rows) {
    const key = dayKey(r.start, timeZone);
    const d = days.get(key) ?? { day: key, peakKw: null, peakStart: null, importKwh: 0 };
    d.importKwh += ((r.importWh ?? 0) * cal) / 1000;
    if (r.avgImportKw != null && r.quality !== 'missing') {
      const kw = r.avgImportKw * cal;
      if (d.peakKw == null || kw > d.peakKw) {
        d.peakKw = kw;
        d.peakStart = r.start;
      }
    }
    days.set(key, d);
  }

  const quality: Record<string, number> = {};
  for (const r of rows) quality[r.quality] = (quality[r.quality] ?? 0) + 1;

  return {
    month,
    peak,
    billedKw: billedKw(peak?.kw ?? 0, tariff),
    costEur: monthlyCost(peak?.kw ?? 0, tariff),
    tariffId: tariff.id,
    top: top.map((t) => ({
      start: t.start,
      kw: t.avgImportKw,
      maxImportKw: t.maxImportW == null ? null : (t.maxImportW * cal) / 1000,
      quality: t.quality,
    })),
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    quality,
    intervalCount: rows.length,
  };
}

/** Parse "YYYY-MM" into local year/month numbers. */
export function parseMonth(month: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('month must be YYYY-MM');
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function currentMonth(now: number, timeZone: string): string {
  const p = localParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** [from, to) epoch range of a local month. */
export function monthRange(month: string, timeZone: string): { from: number; to: number } {
  const { year, month: m } = parseMonth(month);
  return {
    from: zonedToEpoch(year, m, 1, 0, 0, timeZone),
    to: zonedToEpoch(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1, 1, 0, 0, timeZone),
  };
}

export interface YearSummary {
  year: number;
  months: {
    month: string;
    peakKw: number | null;
    peakStart: number | null;
    billedKw: number | null;
    costEur: number | null;
    importKwh: number;
    intervalCount: number;
  }[];
  totalCostEur: number;
}

/** Monthly peaks and capacity charges of a year (pure; calibrated). Months without data have nulls. */
export function summarizeYear(
  year: number,
  rows: readonly ClosedInterval[],
  settings: Settings,
  timeZone: string,
): YearSummary {
  const byMonth = new Map<string, ClosedInterval[]>();
  for (const r of rows) {
    const p = localParts(r.start, timeZone);
    const key = `${p.year}-${String(p.month).padStart(2, '0')}`;
    byMonth.set(key, [...(byMonth.get(key) ?? []), r]);
  }
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const list = byMonth.get(key) ?? [];
    if (list.length === 0) {
      return {
        month: key,
        peakKw: null,
        peakStart: null,
        billedKw: null,
        costEur: null,
        importKwh: 0,
        intervalCount: 0,
      };
    }
    const s = summarizeMonth(key, list, settings, timeZone, 1);
    return {
      month: key,
      peakKw: s.peak?.kw ?? null,
      peakStart: s.peak?.start ?? null,
      billedKw: s.billedKw,
      costEur: s.costEur,
      importKwh: s.daily.reduce((a, d) => a + d.importKwh, 0),
      intervalCount: list.length,
    };
  });
  return { year, months, totalCostEur: months.reduce((a, m) => a + (m.costEur ?? 0), 0) };
}
