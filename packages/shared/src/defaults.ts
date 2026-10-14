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
};
