import { DEFAULT_TIME_ZONE } from '@peak-guard/core';
import i18n from 'i18next';

export const TIME_ZONE = DEFAULT_TIME_ZONE;

const locale = () => (i18n.language?.startsWith('de') ? 'de-AT' : 'en-GB');

export function fmtNumber(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return '–';
  return new Intl.NumberFormat(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

export const fmtKw = (w: number | null | undefined, digits = 2) =>
  w == null ? '–' : `${fmtNumber(w, digits)} kW`;
export const fmtW = (w: number | null | undefined) =>
  w == null ? '–' : Math.abs(w) >= 1000 ? `${fmtNumber(w / 1000, 2)} kW` : `${fmtNumber(w, 0)} W`;

export function fmtEur(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'EUR' }).format(v);
}

export function fmtTime(ts: number, withSeconds = false): string {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }).format(ts);
}

export function fmtDateTime(ts: number): string {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: TIME_ZONE,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(
  ts: number,
  opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit' },
): string {
  return new Intl.DateTimeFormat(locale(), { timeZone: TIME_ZONE, ...opts }).format(ts);
}

export function fmtMonth(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale(), {
    month: style,
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(y, m - 1, 15));
}

/** Localized short weekday names, Monday first. */
export function weekdayNames(): string[] {
  const f = new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2024, 0, 1 + i))); // 2024-01-01 is a Monday
}
