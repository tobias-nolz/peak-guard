import { DEFAULT_TARIFFS } from '@peak-guard/core';
import type { Settings } from './settings.js';

export const DEFAULT_SETTINGS: Settings = {
  thresholdKw: 10,
  warnRatio: 0.9,
  calibrationFactor: 1,
  projectionSmoothingS: 10,
  tariffs: DEFAULT_TARIFFS,
  // BYD Battery-Box Premium HVS 10.2 behind a Gen24; adjust in Settings.
  battery: { capacityKwh: 10.24, maxPowerKw: null, minSocPct: 5 },
  control: {
    mode: 'dryRun',
    reservePct: 40,
    adaptive: true,
    marginKw: 0.2,
    minUpdateIntervalS: 10,
    minChangeW: 200,
    revertTimeoutS: 120,
    acknowledgeNoRevert: false,
  },
  notifications: {
    events: {
      approaching: true,
      newPeak: true,
      reserveDepleted: true,
      connectionLost: true,
      controlSafeMode: true,
    },
    cooldownMinutes: 15,
  },
  loadShedding: [],
  // Unknown until the 2027 tariffs are published; add windows in Settings.
  gridFeeWindows: [],
};

/**
 * Version of docker-compose.yml, passed to the collector as PEAK_GUARD_COMPOSE_VERSION.
 * Bump it whenever the collector gets new environment variables: Compose only passes
 * what the file lists, so an older file silently drops settings made in .env.
 */
export const COMPOSE_VERSION = 1;

/**
 * Why the collector's write kill switch blocks control, with the fix. `composeVersion`
 * is what the collector received (null = an older docker-compose.yml without it).
 */
export function writesDisabledMessage(composeVersion: number | null | undefined): string {
  if (composeVersion == null || composeVersion < COMPOSE_VERSION) {
    return 'writes are disabled: the collector runs with CONTROL_WRITES_ENABLED=false, and your docker-compose.yml is older than the images, so settings from .env (CONTROL_WRITES_ENABLED, MODBUS_*, …) may not reach the collector. Download the current docker-compose.yml, then `docker compose up -d`';
  }
  return 'writes are disabled: the collector runs with CONTROL_WRITES_ENABLED=false. Set it to true in .env, then recreate the collector (`docker compose up -d collector`; `restart` keeps the old value)';
}
