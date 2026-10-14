/**
 * Peak-shaving decision logic — pure, shared by the what-if simulation and the live
 * controller (dry-run / active).
 *
 * Concept: part of the battery (the reserve) is kept for peak shaving. Above the reserve
 * the inverter runs its normal self-consumption mode. At or below the reserve, discharge
 * is blocked unless the running quarter-hour would otherwise exceed the target; then the
 * battery may discharge exactly the power needed to stay within the interval's energy
 * budget. Only discharge *limits* are produced — never forced charge/discharge — so a
 * stuck setpoint can only reduce battery use.
 */

import { INTERVAL_MS } from './time.js';

export interface ControlConfig {
  /** Peak level to stay below (kW). */
  thresholdKw: number;
  /** Minimum billed power (kW); shaving below it saves nothing. */
  minBilledKw: number;
  /** Also never shave below the month's peak so far (energy would be spent for nothing). */
  adaptive: boolean;
  /** Aim this much below the target to absorb measurement noise and lag (kW). */
  marginKw: number;
  /** SoC (%) at or below which the battery is reserved for peak shaving. */
  reservePct: number;
  /** Absolute minimum SoC (%) — the inverter's own floor plus safety. */
  minSocPct: number;
  /** Max discharge power of the battery path (W). */
  maxDischargeW: number;
}

export interface ControlInputs {
  /** Time within the interval. */
  elapsedMs: number;
  /** Grid import energy so far in this interval (Wh, calibrated). */
  importWh: number;
  /** Current grid import (W, + import / − export; smoothed). */
  gridW: number;
  /** Current battery power (W, + discharge / − charge). */
  batteryW: number;
  socPct: number;
  /** Month peak so far (kW), for adaptive mode. */
  monthPeakKw: number | null;
}

export type ControlMode =
  /** SoC above the reserve: the inverter's own self-consumption logic applies. */
  | 'release'
  /** At/below the reserve and no peak threat: discharge blocked to keep the reserve. */
  | 'hold'
  /** Peak threat: discharge limited to the power needed to meet the target. */
  | 'shave'
  /** Battery at its absolute floor: nothing to give. */
  | 'empty';

export interface ControlDecision {
  mode: ControlMode;
  targetKw: number;
  /**
   * Discharge limit to apply (W); null = no limit (inverter self-consumption).
   * 0 = discharge blocked.
   */
  dischargeLimitW: number | null;
  /** Discharge needed to meet the target (W), before clamping to battery limits. */
  requiredW: number;
  /** Projected interval average without any additional discharge (kW). */
  projectedKw: number;
}

export function effectiveTarget(cfg: ControlConfig, monthPeakKw: number | null): number {
  return Math.max(cfg.thresholdKw, cfg.minBilledKw, cfg.adaptive ? (monthPeakKw ?? 0) : 0);
}

export function decide(i: ControlInputs, cfg: ControlConfig): ControlDecision {
  const targetKw = effectiveTarget(cfg, i.monthPeakKw);
  const remainingMs = Math.max(1_000, INTERVAL_MS - i.elapsedMs);
  const remainingH = remainingMs / 3_600_000;
  // Energy we may still import in this quarter-hour while staying below target − margin.
  const budgetWh = (targetKw - cfg.marginKw) * 1000 * (INTERVAL_MS / 3_600_000);
  const leftWh = budgetWh - i.importWh;
  // Net demand the battery could serve = what's imported now plus what it already delivers.
  const demandW = Math.max(0, i.gridW) + Math.max(0, i.batteryW);
  const affordableW = leftWh / remainingH;
  const requiredW = Math.max(0, demandW - affordableW);
  const projectedKw =
    (i.importWh + Math.max(0, i.gridW) * remainingH) / 1000 / (INTERVAL_MS / 3_600_000);

  if (i.socPct <= cfg.minSocPct) {
    return { mode: 'empty', targetKw, dischargeLimitW: 0, requiredW, projectedKw };
  }
  if (i.socPct > cfg.reservePct) {
    return { mode: 'release', targetKw, dischargeLimitW: null, requiredW, projectedKw };
  }
  if (requiredW <= 0) {
    return { mode: 'hold', targetKw, dischargeLimitW: 0, requiredW, projectedKw };
  }
  return {
    mode: 'shave',
    targetKw,
    dischargeLimitW: Math.min(cfg.maxDischargeW, requiredW),
    requiredW,
    projectedKw,
  };
}
