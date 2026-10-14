import { describe, expect, it } from 'vitest';
import {
  INTERVAL_MS,
  dayKey,
  intervalStart,
  intervalsInLocalDay,
  localParts,
  monthKey,
  startOfLocalDay,
  startOfLocalMonth,
  startOfNextLocalMonth,
  zonedToEpoch,
} from './time.js';

const iso = (s: string) => Date.parse(s);

describe('quarter-hour alignment', () => {
  it('floors to :00/:15/:30/:45', () => {
    expect(intervalStart(iso('2027-01-15T10:14:59.999Z'))).toBe(iso('2027-01-15T10:00:00Z'));
    expect(intervalStart(iso('2027-01-15T10:15:00Z'))).toBe(iso('2027-01-15T10:15:00Z'));
    expect(intervalStart(iso('2027-01-15T10:44:00Z'))).toBe(iso('2027-01-15T10:30:00Z'));
  });

  it('is aligned to local Vienna wall-clock quarters in summer and winter', () => {
    for (const ts of [iso('2027-07-01T08:37:12Z'), iso('2027-01-01T08:37:12Z')]) {
      const p = localParts(intervalStart(ts));
      expect(p.minute % 15).toBe(0);
      expect(p.second).toBe(0);
    }
  });
});

describe('DST handling (Europe/Vienna)', () => {
  it('spring-forward day has 92 quarter-hours, fall-back 100, normal 96', () => {
    expect(intervalsInLocalDay(iso('2026-03-29T12:00:00Z'))).toBe(92);
    expect(intervalsInLocalDay(iso('2026-10-25T12:00:00Z'))).toBe(100);
    expect(intervalsInLocalDay(iso('2026-10-24T12:00:00Z'))).toBe(96);
    expect(intervalsInLocalDay(iso('2027-03-28T12:00:00Z'))).toBe(92);
  });

  it('distinguishes the repeated 02:00-03:00 hour on fall-back night', () => {
    const first = localParts(iso('2026-10-25T00:30:00Z'));
    const second = localParts(iso('2026-10-25T01:30:00Z'));
    expect([first.hour, first.minute]).toEqual([2, 30]);
    expect([second.hour, second.minute]).toEqual([2, 30]);
    expect(
      intervalStart(iso('2026-10-25T01:30:00Z')) - intervalStart(iso('2026-10-25T00:30:00Z')),
    ).toBe(4 * INTERVAL_MS);
  });

  it('resolves ambiguous and non-existent local times', () => {
    expect(zonedToEpoch(2026, 10, 25, 2, 30)).toBe(iso('2026-10-25T00:30:00Z'));
    expect(zonedToEpoch(2026, 3, 29, 2, 30)).toBe(iso('2026-03-29T01:30:00Z'));
    expect(zonedToEpoch(2026, 3, 29, 3, 0)).toBe(iso('2026-03-29T01:00:00Z'));
  });
});

describe('local day and month boundaries', () => {
  it('computes month starts in local time', () => {
    expect(startOfLocalMonth(iso('2026-10-14T12:00:00Z'))).toBe(iso('2026-09-30T22:00:00Z'));
    expect(startOfNextLocalMonth(iso('2026-10-14T12:00:00Z'))).toBe(iso('2026-10-31T23:00:00Z'));
    expect(startOfNextLocalMonth(iso('2026-12-14T12:00:00Z'))).toBe(iso('2026-12-31T23:00:00Z'));
  });

  it('assigns the first local quarter-hour of a month to that month', () => {
    // 2027-02-01 00:00 local = 2027-01-31T23:00Z
    expect(monthKey(iso('2027-01-31T23:00:00Z'))).toBe('2027-02');
    expect(monthKey(iso('2027-01-31T22:45:00Z'))).toBe('2027-01');
    expect(dayKey(iso('2027-01-31T23:00:00Z'))).toBe('2027-02-01');
  });

  it('startOfLocalDay on DST days', () => {
    expect(startOfLocalDay(iso('2026-03-29T20:00:00Z'))).toBe(iso('2026-03-28T23:00:00Z'));
    expect(startOfLocalDay(iso('2026-10-25T20:00:00Z'))).toBe(iso('2026-10-24T22:00:00Z'));
  });
});
