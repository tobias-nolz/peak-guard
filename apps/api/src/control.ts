import { INTERVAL_MS, intervalStart, type ClosedInterval } from '@peak-guard/core';
import { writesDisabledMessage, type ControlSettings } from '@peak-guard/shared';

/** Controller status as published by the collector (kv 'control.status'). */
export interface ControlStatus {
  ts: number;
  mode: string;
  writesEnabled: boolean;
  /** PEAK_GUARD_COMPOSE_VERSION the collector received (null/absent: older compose file) */
  composeVersion?: number | null;
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
 * acknowledged as unavailable. Grid charging in Active needs a *passed* revert test (an
 * acknowledgement is not enough: a stuck forced charge would import power).
 */
export function activeBlockedReason(
  next: ControlSettings,
  status: ControlStatus | null,
  now = Date.now(),
): string | null {
  if (next.mode !== 'active') return null;
  if (!status || now - status.ts > 60_000)
    return 'collector status unavailable — is the collector running?';
  if (!status.writesEnabled) return writesDisabledMessage(status.composeVersion);
  if (status.modbus.state !== 'ok')
    return `Modbus is not available (${status.modbus.state}${status.modbus.error ? `: ${status.modbus.error}` : ''})`;
  if (status.revertTest?.status !== 'passed' && !next.acknowledgeNoRevert) {
    return 'run the revert self-test first, or acknowledge that the inverter may not revert on its own';
  }
  if (next.gridCharge.enabled && status.revertTest?.status !== 'passed') {
    return 'grid charging needs a passed revert self-test (acknowledging is not enough) — run the revert self-test or disable grid charging';
  }
  return null;
}

export interface DecisionLike {
  ts: number;
  decision: string;
  limitW: number | null;
  chargeW?: number | null;
}

export interface DryRunInterval {
  start: number;
  actualKw: number;
  /** Energy the controller would have discharged in shave mode (Wh). */
  shaveWh: number;
  /** Energy the controller would have charged from the grid (Wh). */
  chargeWh: number;
  predictedKw: number;
}

/**
 * Estimate what shaving would have achieved: integrate the shave limits of the decision
 * log per quarter-hour (each decision holds until the next one, at most `maxHoldMs`) and
 * subtract that energy from the measured interval energy; grid charging adds its energy.
 * An estimate — the real battery might also have behaved differently before the peak.
 */
export function dryRunEstimate(
  intervals: readonly ClosedInterval[],
  decisions: readonly DecisionLike[],
  calibration = 1,
  maxHoldMs = 60_000,
): DryRunInterval[] {
  const shave = new Map<number, number>();
  const charge = new Map<number, number>();
  for (let k = 0; k < decisions.length; k++) {
    const d = decisions[k]!;
    const [map, w] =
      d.decision === 'shave'
        ? [shave, d.limitW]
        : d.decision === 'charge'
          ? [charge, d.chargeW]
          : [null, null];
    if (!map || !w) continue;
    const end = Math.min(decisions[k + 1]?.ts ?? d.ts + maxHoldMs, d.ts + maxHoldMs);
    let t = d.ts;
    while (t < end) {
      const s = intervalStart(t);
      const e = Math.min(end, s + INTERVAL_MS);
      map.set(s, (map.get(s) ?? 0) + (w * (e - t)) / 3_600_000);
      t = e;
    }
  }
  return intervals
    .filter((i) => i.avgImportKw != null && i.quality !== 'missing')
    .map((i) => {
      const actualKw = i.avgImportKw! * calibration;
      const shaveWh = shave.get(i.start) ?? 0;
      const chargeWh = charge.get(i.start) ?? 0;
      return {
        start: i.start,
        actualKw,
        shaveWh,
        chargeWh,
        predictedKw: Math.max(0, actualKw - shaveWh / 250 + chargeWh / 250),
      };
    });
}
