import { describe, expect, it } from 'vitest';
import { activeFeeWindow, type FeeWindow } from './feewindows.js';

const summer: FeeWindow = {
  id: 's',
  label: 'Summer',
  months: [4, 5, 6, 7, 8, 9],
  weekdays: [],
  from: '10:00',
  to: '16:00',
};
const night: FeeWindow = {
  id: 'n',
  label: 'Winter night',
  months: [10, 11, 12, 1, 2, 3],
  weekdays: [0, 1, 2, 3, 4],
  from: '22:00',
  to: '06:00',
};
const at = (iso: string) => Date.parse(iso);

describe('activeFeeWindow', () => {
  it('matches months and local time', () => {
    expect(activeFeeWindow(at('2027-06-01T08:30:00Z'), [summer])?.id).toBe('s'); // 10:30 CEST
    expect(activeFeeWindow(at('2027-06-01T14:00:00Z'), [summer])).toBeNull(); // 16:00 CEST (end exclusive)
    expect(activeFeeWindow(at('2027-01-15T10:00:00Z'), [summer])).toBeNull(); // January
  });

  it('handles overnight windows by their start day', () => {
    // Friday 22:30 local: Friday (4) is allowed
    expect(activeFeeWindow(at('2027-01-15T21:30:00Z'), [night])?.id).toBe('n');
    // Saturday 02:00 local belongs to Friday night → allowed
    expect(activeFeeWindow(at('2027-01-16T01:00:00Z'), [night])?.id).toBe('n');
    // Saturday 23:00 local: Saturday (5) not allowed
    expect(activeFeeWindow(at('2027-01-16T22:00:00Z'), [night])).toBeNull();
    // Sunday 03:00 belongs to Saturday night → not allowed
    expect(activeFeeWindow(at('2027-01-17T02:00:00Z'), [night])).toBeNull();
  });

  it('returns null without windows', () => {
    expect(activeFeeWindow(Date.now(), [])).toBeNull();
  });
});
