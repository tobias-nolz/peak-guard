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
