import { describe, expect, it } from 'vitest';
import { summarizeBattery } from './battery.js';

describe('summarizeBattery', () => {
  const rows = [
    { period: '2027-01-01', chargeWh: 8000, dischargeWh: 7000, minutes: 1440 },
    { period: '2027-01-02', chargeWh: 2000, dischargeWh: 3000, minutes: 1440 },
  ];

  it('converts to kWh and counts equivalent full cycles', () => {
    const s = summarizeBattery(rows, 10);
    expect(s.periods[0]).toEqual({
      period: '2027-01-01',
      chargeKwh: 8,
      dischargeKwh: 7,
      cycles: 0.75,
      minutes: 1440,
    });
    expect(s.total).toEqual({ chargeKwh: 10, dischargeKwh: 10, cycles: 1, minutes: 2880 });
  });

  it('has no cycles without a known capacity', () => {
    const s = summarizeBattery(rows, null);
    expect(s.total.cycles).toBeNull();
    expect(s.periods.every((p) => p.cycles === null)).toBe(true);
    expect(summarizeBattery(rows, 0).total.cycles).toBeNull();
  });

  it('is all zeros without data', () => {
    expect(summarizeBattery([], 10).total).toEqual({
      chargeKwh: 0,
      dischargeKwh: 0,
      cycles: 0,
      minutes: 0,
    });
  });
});
