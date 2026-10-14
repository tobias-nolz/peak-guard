import { describe, expect, it } from 'vitest';
import { shedStep, type ShedRule } from './loadshed.js';

const rule: ShedRule = {
  triggerRatio: 0.95,
  releaseRatio: 0.8,
  minOnMs: 5 * 60_000,
  maxOnMs: 60 * 60_000,
  minOffMs: 5 * 60_000,
};
const off = { active: false, since: null };
const at = (now: number, projectedKw: number, elapsedMs = 120_000) => ({
  now,
  projectedKw,
  targetKw: 10,
  elapsedMs,
});

describe('shedStep', () => {
  it('sheds when the projection reaches the trigger, not in the first minute', () => {
    expect(shedStep(rule, off, at(0, 9.4))).toBeNull();
    expect(shedStep(rule, off, at(0, 9.6))).toBe('shed');
    expect(shedStep(rule, off, at(0, 12, 30_000))).toBeNull();
  });

  it('restores after the minimum on time once the projection is low', () => {
    const on = { active: true, since: 0 };
    expect(shedStep(rule, on, at(60_000, 5))).toBeNull(); // min on time
    expect(shedStep(rule, on, at(6 * 60_000, 8.5))).toBeNull(); // still above release
    expect(shedStep(rule, on, at(6 * 60_000, 7.9))).toBe('restore');
    expect(shedStep(rule, on, at(61 * 60_000, 12))).toBe('restore'); // max on time
  });

  it('waits the minimum off time before shedding again', () => {
    const restored = { active: false, since: 0 };
    expect(shedStep(rule, restored, at(60_000, 11))).toBeNull();
    expect(shedStep(rule, restored, at(5 * 60_000, 11))).toBe('shed');
  });
});
