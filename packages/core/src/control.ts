/**
 * Peak-shaving decision logic — pure, shared by the what-if simulation and the live
 * controller (dry-run / active).
 *
 * Concept: part of the battery (the reserve) is kept for peak shaving. Above the reserve
 * the inverter runs its normal self-consumption mode. At or below the reserve, discharge
 * is blocked unless the running quarter-hour would otherwise exceed the target; then the
 * battery may discharge exactly the power needed to stay within the interval's energy
 * budget. decide() only produces discharge *limits* — never forced charge/discharge — so a
 * stuck setpoint can only reduce battery use. The opt-in applyGridCharge() adds a forced
 * charge (up to the reserve) on top; the collector gates it more strictly.
 */

import { DEFAULT_TIME_ZONE, INTERVAL_MS, localParts } from './time.js';

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
  | 'empty'
  /** Reserve being refilled from the grid (see applyGridCharge). */
  | 'charge';

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
  /** Forced grid charge power (W), only in mode 'charge' (0 = session paused). */
  chargeW?: number;
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
  // While the battery charges from the grid, that charge power is not house demand.
  const demandW = Math.max(0, i.gridW + i.batteryW, i.batteryW);
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

/** Grid-charge parameters (see @peak-guard/shared gridChargeSchema). */
export interface GridChargeConfig {
  enabled: boolean;
  hysteresisPct: number;
  maxPowerW: number;
  minPowerW: number;
  headroomKw: number;
  cooldownMinutes: number;
}

/** Session state across ticks; persist it so a restart doesn't reset the cooldown. */
export interface GridChargeState {
  active: boolean;
  since: number | null;
  lastStopAt: number | null;
  lastShaveAt: number | null;
}

export const GRID_CHARGE_IDLE: GridChargeState = {
  active: false,
  since: null,
  lastStopAt: null,
  lastShaveAt: null,
};

export interface GridChargeResult {
  decision: ControlDecision;
  state: GridChargeState;
  /** Why no charging happens right now (null while charging or when disabled). */
  reason: string | null;
}

/** True if the local time of `ts` lies in [from, to) ("HH:MM"; across midnight if from > to; from == to: all day). */
export function inLocalWindow(
  ts: number,
  from: string,
  to: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): boolean {
  if (from === to) return true;
  const { hour, minute } = localParts(ts, timeZone);
  return minuteInWindow(hour * 60 + minute, from, to);
}

/** Like inLocalWindow, for a local minute of the day (0..1439). */
export function minuteInWindow(minuteOfDay: number, from: string, to: string): boolean {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const f = toMin(from);
  const t = toMin(to);
  const m = minuteOfDay;
  if (f === t) return true;
  return f < t ? m >= f && m < t : m >= f || m < t;
}

/**
 * Refill the reserve from the grid on top of a decide() result — pure.
 *
 * Charges only up to the reserve (above it the inverter's self-consumption would spend
 * the grid energy again). A session starts at SoC ≤ reserve − hysteresis, inside the time
 * window, with enough peak-safe headroom, and only after the cooldown since the last
 * session end *and* the last shave. Inside a session the power follows the headroom
 * down to 0 W (= hold) without ending the session, so it doesn't flip-flop. A shave need,
 * reaching the reserve, leaving the window or disabling ends it immediately.
 */
export function applyGridCharge(
  base: ControlDecision,
  i: ControlInputs,
  cfg: ControlConfig,
  gc: GridChargeConfig & { inWindow: boolean },
  state: GridChargeState,
  nowMs: number,
): GridChargeResult {
  const stop = (s: GridChargeState): GridChargeState =>
    s.active ? { ...s, active: false, since: null, lastStopAt: nowMs } : s;

  if (base.mode === 'shave') {
    return { decision: base, state: { ...stop(state), lastShaveAt: nowMs }, reason: 'shaving' };
  }
  if (!gc.enabled) return { decision: base, state: stop(state), reason: null };
  if (base.mode === 'release' || i.socPct >= cfg.reservePct) {
    return { decision: base, state: stop(state), reason: 'reserve full' };
  }
  if (!gc.inWindow) return { decision: base, state: stop(state), reason: 'outside time window' };

  // Peak-safe charge power: stay headroomKw below target − margin, never above the
  // interval's remaining average budget, after the house's own net import.
  const remainingH = Math.max(1_000, INTERVAL_MS - i.elapsedMs) / 3_600_000;
  const budgetWh = (base.targetKw - cfg.marginKw) * 1000 * (INTERVAL_MS / 3_600_000);
  const affordableW = (budgetWh - i.importWh) / remainingH;
  const ceilingW =
    Math.min(affordableW, (base.targetKw - cfg.marginKw) * 1000) - gc.headroomKw * 1000;
  const houseW = Math.max(0, i.gridW + i.batteryW);
  const capW = Math.min(gc.maxPowerW, cfg.maxDischargeW);
  const rawW = Math.max(0, Math.min(capW, ceilingW - houseW));
  const powerW = rawW >= gc.minPowerW ? Math.round(rawW) : 0;
  const charge = (s: GridChargeState): GridChargeResult => ({
    decision: { ...base, mode: 'charge', dischargeLimitW: 0, chargeW: powerW },
    state: s,
    reason: powerW > 0 ? null : 'no peak-safe headroom (paused)',
  });

  if (state.active) return charge(state);

  if (i.socPct > cfg.reservePct - gc.hysteresisPct) {
    return { decision: base, state, reason: 'SoC above the start level' };
  }
  const cooldownMs = gc.cooldownMinutes * 60_000;
  const last = Math.max(state.lastStopAt ?? -Infinity, state.lastShaveAt ?? -Infinity);
  if (nowMs - last < cooldownMs) {
    const leftMin = Math.ceil((cooldownMs - (nowMs - last)) / 60_000);
    return { decision: base, state, reason: `cooldown (${leftMin} min left)` };
  }
  if (powerW <= 0) return { decision: base, state, reason: 'no peak-safe headroom' };
  return charge({ ...state, active: true, since: nowMs });
}
