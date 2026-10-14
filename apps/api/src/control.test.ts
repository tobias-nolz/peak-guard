import { describe, expect, it } from 'vitest';
import type { ClosedInterval } from '@peak-guard/core';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { activeBlockedReason, dryRunEstimate, type ControlStatus } from './control.js';

const status = (patch: Partial<ControlStatus> = {}): ControlStatus => ({
  ts: 1_000_000,
  mode: 'dryRun',
  writesEnabled: true,
  modbus: { state: 'ok', error: null, storage: null, model: null },
  decision: null,
  command: null,
  note: null,
  revertTest: { status: 'passed', startedAt: 0, finishedAt: 1, message: '' },
  ...patch,
});
const active = { ...DEFAULT_SETTINGS.control, mode: 'active' as const };

describe('activeBlockedReason', () => {
  it('allows non-active modes unconditionally', () => {
    expect(activeBlockedReason({ ...active, mode: 'dryRun' }, null)).toBeNull();
  });
  it('requires a fresh status, writes, Modbus and a passed (or acknowledged) revert test', () => {
    const now = 1_000_000;
    expect(activeBlockedReason(active, status(), now)).toBeNull();
    expect(activeBlockedReason(active, null, now)).toMatch(/collector/);
    expect(activeBlockedReason(active, status({ ts: 0 }), now)).toMatch(/collector/);
    expect(activeBlockedReason(active, status({ writesEnabled: false }), now)).toMatch(
      /CONTROL_WRITES_ENABLED/,
    );
    expect(
      activeBlockedReason(
        active,
        status({ modbus: { state: 'error', error: 'timeout', storage: null, model: null } }),
        now,
      ),
    ).toMatch(/timeout/);
    expect(activeBlockedReason(active, status({ revertTest: null }), now)).toMatch(
      /revert self-test/,
    );
    expect(
      activeBlockedReason(
        { ...active, acknowledgeNoRevert: true },
        status({ revertTest: null }),
        now,
      ),
    ).toBeNull();
  });
});

describe('dryRunEstimate', () => {
  const T0 = Date.parse('2027-01-15T17:00:00Z');
  const iv = (start: number, kw: number): ClosedInterval => ({
    start,
    importWh: kw * 250,
    exportWh: 0,
    avgImportKw: kw,
    avgExportKw: 0,
    completeness: 1,
    quality: 'exact',
    source: 'counter',
    sampleCount: 1,
    maxImportW: null,
    integratedImportWh: 0,
  });
  it('subtracts the shave energy of the decisions from each quarter-hour', () => {
    // 2 kW shave for 15 min (logged every 15 s), then hold
    const decisions = Array.from({ length: 60 }, (_, k) => ({
      ts: T0 + k * 15_000,
      decision: 'shave',
      limitW: 2_000,
    }));
    decisions.push({ ts: T0 + 900_000, decision: 'hold', limitW: 0 });
    const r = dryRunEstimate([iv(T0, 12), iv(T0 + 900_000, 4)], decisions);
    expect(r[0]!.actualKw).toBe(12);
    expect(r[0]!.predictedKw).toBeCloseTo(10, 6);
    expect(r[0]!.shaveWh).toBeCloseTo(500, 6);
    expect(r[1]).toMatchObject({ actualKw: 4, shaveWh: 0, predictedKw: 4 });
  });
  it('caps how long a single decision holds', () => {
    const r = dryRunEstimate([iv(T0, 12)], [{ ts: T0, decision: 'shave', limitW: 3_000 }]);
    expect(r[0]!.shaveWh).toBeCloseTo(50, 6); // 3 kW × 60 s
  });
});
