import type { ControlDecision } from '@peak-guard/core';
import { STORAGE_DEFAULTS, type StorageCommand } from '@peak-guard/fronius';

/**
 * Translate a decision into the model 124 command that implements it. Only discharge
 * limits (StorCtl_Mod bit 1, OutWRte ≥ 0) are used; charging is never limited, so PV can
 * always refill the reserve.
 */
export function commandFor(d: ControlDecision, wChaMaxW: number, revertS: number): StorageCommand {
  if (d.dischargeLimitW == null) return STORAGE_DEFAULTS;
  const pct = wChaMaxW > 0 ? Math.min(100, Math.max(0, (d.dischargeLimitW / wChaMaxW) * 100)) : 0;
  return {
    storCtlMod: 2,
    outWRtePct: Math.round(pct * 100) / 100,
    inWRtePct: 100,
    rvrtTmsS: revertS,
  };
}

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
  return (Math.abs(a.outWRtePct - b.outWRtePct) / 100) * wChaMaxW >= minChangeW;
}
