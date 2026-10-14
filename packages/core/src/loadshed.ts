/**
 * Load shedding: switch a flexible load off (or throttle it) while the running
 * quarter-hour is projected close to the target — the cheaper alternative to spending
 * battery energy. Pure decision logic; actions are executed by the collector.
 */

export interface ShedRule {
  /** Shed when projected ≥ triggerRatio × target. */
  triggerRatio: number;
  /** Restore when projected < releaseRatio × target (and min on time passed). */
  releaseRatio: number;
  /** Keep shed at least this long (ms). */
  minOnMs: number;
  /** Never keep shed longer than this (ms) — comfort/safety limit. */
  maxOnMs: number;
  /** After restoring, wait at least this long before shedding again (ms). */
  minOffMs: number;
}

export interface ShedState {
  active: boolean;
  /** Time of the last change (shed or restore), null = never. */
  since: number | null;
}

export interface ShedInputs {
  now: number;
  projectedKw: number;
  targetKw: number;
  /** Time into the quarter-hour; projections in the first minute are too noisy. */
  elapsedMs: number;
}

export type ShedAction = 'shed' | 'restore' | null;

export function shedStep(rule: ShedRule, state: ShedState, i: ShedInputs): ShedAction {
  const age = state.since == null ? Infinity : i.now - state.since;
  if (state.active) {
    if (age >= rule.maxOnMs) return 'restore';
    if (age >= rule.minOnMs && i.projectedKw < rule.releaseRatio * i.targetKw) return 'restore';
    return null;
  }
  if (age < rule.minOffMs || i.elapsedMs < 60_000) return null;
  return i.projectedKw >= rule.triggerRatio * i.targetKw ? 'shed' : null;
}
