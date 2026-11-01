import type { ControlDecision } from '@peak-guard/core';
import { STORAGE_DEFAULTS, type StorageCommand } from '@peak-guard/fronius';

/** Revert timeout cap for forced-charge commands (s): a stuck charge must end quickly. */
export const CHARGE_REVERT_MAX_S = 60;

/**
 * Translate a decision into the model 124 command that implements it. Discharge limits
 * use StorCtl_Mod bit 1 with OutWRte ≥ 0; charging is never limited, so PV can always
 * refill the reserve. Grid charging ('charge') uses a negative OutWRte (forced charge)
 * with a short revert timeout; writing it needs `allowForcedCharge`.
 */
export function commandFor(d: ControlDecision, wChaMaxW: number, revertS: number): StorageCommand {
  if (d.mode === 'charge' && (d.chargeW ?? 0) > 0) {
    const pct = wChaMaxW > 0 ? Math.min(100, ((d.chargeW ?? 0) / wChaMaxW) * 100) : 0;
    return {
      storCtlMod: 2,
      outWRtePct: -Math.round(pct * 100) / 100,
      inWRtePct: 100,
      rvrtTmsS: Math.min(revertS, CHARGE_REVERT_MAX_S),
    };
  }
  if (d.dischargeLimitW == null) return STORAGE_DEFAULTS;
  const pct = wChaMaxW > 0 ? Math.min(100, Math.max(0, (d.dischargeLimitW / wChaMaxW) * 100)) : 0;
  return {
    storCtlMod: 2,
    outWRtePct: Math.round(pct * 100) / 100,
    inWRtePct: 100,
    rvrtTmsS: revertS,
  };
}

/** True if the command forces charging (negative OutWRte). */
export const isForcedCharge = (c: StorageCommand | null) =>
  !!c && c.storCtlMod !== 0 && c.outWRtePct < 0;

/** True if switching from `a` to `b` is worth a write (mode change, or a large enough limit change). */
export function significantChange(
  a: StorageCommand | null,
  b: StorageCommand,
  minChangeW: number,
  wChaMaxW: number,
): boolean {
  if (!a) return true;
  if (a.storCtlMod !== b.storCtlMod) return true;
  if (b.storCtlMod === 0) return false;
  // Always react immediately when a limit must be lifted to 0 % or raised from 0 %.
  if ((a.outWRtePct === 0) !== (b.outWRtePct === 0)) return true;
  // Switching between forced charging and a discharge limit is always significant.
  if (a.outWRtePct < 0 !== b.outWRtePct < 0) return true;
  return (Math.abs(a.outWRtePct - b.outWRtePct) / 100) * wChaMaxW >= minChangeW;
}
