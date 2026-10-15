import { INTERVAL_MS, intervalStart, type ClosedInterval } from '@peak-guard/core';
import { WRITES_DISABLED_MESSAGE, type ControlSettings } from '@peak-guard/shared';

/** Controller status as published by the collector (kv 'control.status'). */
export interface ControlStatus {
  ts: number;
  mode: string;
  writesEnabled: boolean;
  modbus: {
    state: 'disabled' | 'ok' | 'error';
    error: string | null;
    storage: unknown;
    model: unknown;
  };
  decision: unknown;
  command: unknown;
  note: string | null;
  applying?: boolean;
  fault?: string | null;
  pausedUntil?: number | null;
  revertTest: {
    status: 'running' | 'passed' | 'failed';
    startedAt: number;
    finishedAt: number | null;
    message: string;
  } | null;
}

/**
 * Why switching to Active is not allowed (null = allowed). The collector status must be
 * fresh, writes enabled, Modbus working and the revert self-test passed — or explicitly
 * acknowledged as unavailable.
 */
export function activeBlockedReason(
  next: ControlSettings,
  status: ControlStatus | null,
  now = Date.now(),
): string | null {
  if (next.mode !== 'active') return null;
  if (!status || now - status.ts > 60_000)
    return 'collector status unavailable — is the collector running?';
  if (!status.writesEnabled) return WRITES_DISABLED_MESSAGE;
  if (status.modbus.state !== 'ok')
    return `Modbus is not available (${status.modbus.state}${status.modbus.error ? `: ${status.modbus.error}` : ''})`;
  if (status.revertTest?.status !== 'passed' && !next.acknowledgeNoRevert) {
    return 'run the revert self-test first, or acknowledge that the inverter may not revert on its own';
  }
  return null;
}

export interface DecisionLike {
  ts: number;
  decision: string;
  limitW: number | null;
}

export interface DryRunInterval {
  start: number;
  actualKw: number;
  /** Energy the controller would have discharged in shave mode (Wh). */
  shaveWh: number;
  predictedKw: number;
}

/**
 * Estimate what shaving would have achieved: integrate the shave limits of the decision
 * log per quarter-hour (each decision holds until the next one, at most `maxHoldMs`) and
 * subtract that energy from the measured interval energy. An estimate — the real battery
 * might also have behaved differently before the peak.
 */
export function dryRunEstimate(
  intervals: readonly ClosedInterval[],
  decisions: readonly DecisionLike[],
  calibration = 1,
  maxHoldMs = 60_000,
): DryRunInterval[] {
  const shave = new Map<number, number>();
  for (let k = 0; k < decisions.length; k++) {
    const d = decisions[k]!;
    if (d.decision !== 'shave' || !d.limitW) continue;
    const end = Math.min(decisions[k + 1]?.ts ?? d.ts + maxHoldMs, d.ts + maxHoldMs);
    let t = d.ts;
    while (t < end) {
      const s = intervalStart(t);
      const e = Math.min(end, s + INTERVAL_MS);
      shave.set(s, (shave.get(s) ?? 0) + (d.limitW * (e - t)) / 3_600_000);
      t = e;
    }
  }
  return intervals
    .filter((i) => i.avgImportKw != null && i.quality !== 'missing')
    .map((i) => {
      const actualKw = i.avgImportKw! * calibration;
      const shaveWh = shave.get(i.start) ?? 0;
      return {
        start: i.start,
        actualKw,
        shaveWh,
        predictedKw: Math.max(0, actualKw - shaveWh / 250),
      };
    });
}
