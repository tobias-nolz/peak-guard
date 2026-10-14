import { useState } from 'react';
import { localParts, zonedToEpoch } from '@peak-guard/core';
import { TIME_ZONE } from './format';

/** "YYYY-MM" of the local month containing `ts`. */
export function monthOf(ts: number): string {
  const p = localParts(ts, TIME_ZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthBounds(month: string): { from: number; to: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    from: zonedToEpoch(y, m, 1, 0, 0, TIME_ZONE),
    to: zonedToEpoch(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, 0, 0, TIME_ZONE),
  };
}

/** Local midnight of a "YYYY-MM-DD" date. */
export function dateToEpoch(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return zonedToEpoch(y, m, d, 0, 0, TIME_ZONE);
}

/** "YYYY-MM-DD" of the local day containing `ts`. */
export function dateOf(ts: number): string {
  const p = localParts(ts, TIME_ZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Current time, captured once per mount (render must stay pure). */
export function useNow(): number {
  const [now] = useState(() => Date.now());
  return now;
}
