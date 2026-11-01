import { describe, expect, it } from 'vitest';
import {
  GRID_CHARGE_IDLE,
  applyGridCharge,
  decide,
  inLocalWindow,
  type ControlConfig,
  type ControlInputs,
  type GridChargeState,
} from './control.js';

const cfg: ControlConfig = {
  thresholdKw: 10,
  minBilledKw: 10,
  adaptive: false,
  marginKw: 0.2,
  reservePct: 40,
  minSocPct: 5,
  maxDischargeW: 6_000,
};
const gc = {
  enabled: true,
  hysteresisPct: 10,
  maxPowerW: 3_000,
  minPowerW: 500,
  headroomKw: 1,
  cooldownMinutes: 60,
  inWindow: true,
};
const at = (patch: Partial<ControlInputs>): ControlInputs => ({
  elapsedMs: 0,
  importWh: 0,
  gridW: 500,
  batteryW: 0,
  socPct: 20,
  monthPeakKw: null,
  ...patch,
});
const MIN = 60_000;
const run = (i: ControlInputs, s: GridChargeState, now: number, g = gc) =>
  applyGridCharge(decide(i, cfg), i, cfg, g, s, now);

describe('applyGridCharge', () => {
  it('starts below the hysteresis level with peak-safe power', () => {
    const r = run(at({}), GRID_CHARGE_IDLE, 0);
    expect(r.decision.mode).toBe('charge');
    expect(r.decision.chargeW).toBe(3_000); // capped by maxPowerW
    expect(r.decision.dischargeLimitW).toBe(0);
    expect(r.state.active).toBe(true);
  });

  it('never exceeds target − margin − headroom', () => {
    // house 7.5 kW: 10 − 0.2 − 1 − 7.5 = 1.3 kW left
    const r = run(at({ gridW: 7_500 }), GRID_CHARGE_IDLE, 0);
    expect(r.decision.chargeW).toBe(1_300);
  });

  it('does not count its own charge power as house load', () => {
    const r = run(at({ gridW: 3_500, batteryW: -3_000 }), { ...GRID_CHARGE_IDLE, active: true }, 0);
    expect(r.decision.chargeW).toBe(3_000);
  });

  it('does not start between the start level and the reserve', () => {
    const r = run(at({ socPct: 35 }), GRID_CHARGE_IDLE, 0);
    expect(r.decision.mode).toBe('hold');
    expect(r.reason).toMatch(/start level/);
  });

  it('keeps an active session between the start level and the reserve, stops at the reserve', () => {
    const active = { ...GRID_CHARGE_IDLE, active: true, since: 0 };
    expect(run(at({ socPct: 35 }), active, MIN).decision.mode).toBe('charge');
    const r = run(at({ socPct: 40 }), active, 2 * MIN);
    expect(r.decision.mode).toBe('hold');
    expect(r.state).toMatchObject({ active: false, lastStopAt: 2 * MIN });
  });

  it('pauses at 0 W instead of ending when headroom is gone', () => {
    const active = { ...GRID_CHARGE_IDLE, active: true, since: 0 };
    const r = run(at({ gridW: 8_600 }), active, MIN);
    expect(r.decision.mode).toBe('charge');
    expect(r.decision.chargeW).toBe(0);
    expect(r.state.active).toBe(true);
  });

  it('stops immediately when a shave is needed and waits the cooldown before restarting', () => {
    const active = { ...GRID_CHARGE_IDLE, active: true, since: 0 };
    const peak = run(at({ gridW: 12_000 }), active, 5 * MIN);
    expect(peak.decision.mode).toBe('shave');
    expect(peak.state).toMatchObject({ active: false, lastStopAt: 5 * MIN, lastShaveAt: 5 * MIN });

    const soon = run(at({}), peak.state, 30 * MIN);
    expect(soon.decision.mode).toBe('hold');
    expect(soon.reason).toMatch(/cooldown \(35 min left\)/);

    expect(run(at({}), peak.state, 65 * MIN).decision.mode).toBe('charge');
  });

  it('a shave without a prior session also starts the cooldown', () => {
    const peak = run(at({ gridW: 12_000 }), GRID_CHARGE_IDLE, 0);
    expect(peak.state.lastShaveAt).toBe(0);
    expect(run(at({}), peak.state, 10 * MIN).decision.mode).toBe('hold');
  });

  it('ends the session outside the window or when disabled', () => {
    const active = { ...GRID_CHARGE_IDLE, active: true, since: 0 };
    expect(run(at({}), active, MIN, { ...gc, inWindow: false }).state.active).toBe(false);
    const off = run(at({}), active, MIN, { ...gc, enabled: false });
    expect(off.decision.mode).toBe('hold');
    expect(off.state.active).toBe(false);
  });

  it('also charges from the absolute floor', () => {
    expect(run(at({ socPct: 5 }), GRID_CHARGE_IDLE, 0).decision.mode).toBe('charge');
  });
});

describe('inLocalWindow', () => {
  // 2026-01-15 23:30 and 12:00 in Vienna (UTC+1)
  const night = Date.UTC(2026, 0, 15, 22, 30);
  const noon = Date.UTC(2026, 0, 15, 11, 0);
  it('handles windows across midnight', () => {
    expect(inLocalWindow(night, '22:00', '06:00')).toBe(true);
    expect(inLocalWindow(noon, '22:00', '06:00')).toBe(false);
  });
  it('handles same-day windows and all-day', () => {
    expect(inLocalWindow(noon, '10:00', '14:00')).toBe(true);
    expect(inLocalWindow(night, '10:00', '14:00')).toBe(false);
    expect(inLocalWindow(night, '00:00', '00:00')).toBe(true);
  });
});
