import { DEFAULT_TARIFFS } from '@peak-guard/core';
import type { Settings } from './settings.js';

export const DEFAULT_SETTINGS: Settings = {
  thresholdKw: 10,
  warnRatio: 0.9,
  calibrationFactor: 1,
  projectionSmoothingS: 10,
  tariffs: DEFAULT_TARIFFS,
};
