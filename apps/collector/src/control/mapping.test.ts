import { describe, expect, it } from 'vitest';
import type { ControlDecision } from '@peak-guard/core';
import { commandFor, significantChange } from './mapping.js';

const d = (mode: ControlDecision['mode'], limit: number | null): ControlDecision => ({
  mode,
  targetKw: 10,
  dischargeLimitW: limit,
  requiredW: limit ?? 0,
  projectedKw: 9,
});

describe('commandFor', () => {
  it('maps release to the inverter defaults and limits to OutWRte', () => {
    expect(commandFor(d('release', null), 6_000, 120)).toEqual({
      storCtlMod: 0,
      outWRtePct: 100,
      inWRtePct: 100,
      rvrtTmsS: 0,
    });
    expect(commandFor(d('hold', 0), 6_000, 120)).toEqual({
      storCtlMod: 2,
      outWRtePct: 0,
      inWRtePct: 100,
      rvrtTmsS: 120,
    });
    expect(commandFor(d('shave', 1_500), 6_000, 120)).toEqual({
      storCtlMod: 2,
      outWRtePct: 25,
      inWRtePct: 100,
      rvrtTmsS: 120,
    });
    expect(commandFor(d('shave', 9_000), 6_000, 120).outWRtePct).toBe(100);
  });
});

describe('significantChange', () => {
  const hold = { storCtlMod: 2, outWRtePct: 0, inWRtePct: 100, rvrtTmsS: 120 };
  const at = (pct: number) => ({ ...hold, outWRtePct: pct });
  it('applies hysteresis to limit changes', () => {
    expect(significantChange(null, hold, 200, 6_000)).toBe(true);
    expect(significantChange(at(20), at(22), 200, 6_000)).toBe(false); // 120 W
    expect(significantChange(at(20), at(24), 200, 6_000)).toBe(true); // 240 W
    expect(significantChange(at(0), at(1), 200, 6_000)).toBe(true); // leaving hold
    expect(
      significantChange(
        at(20),
        { storCtlMod: 0, outWRtePct: 100, inWRtePct: 100, rvrtTmsS: 0 },
        200,
        6_000,
      ),
    ).toBe(true);
  });
});
