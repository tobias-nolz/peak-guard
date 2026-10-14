import { HOUR_MS, MINUTE_MS, dayKey, localParts, startOfLocalDay } from '@peak-guard/core';
import { hashString, rng } from './rng.js';

export interface LoadEvent {
  name: string;
  start: number;
  end: number;
  watts: number;
}

export interface DayPlan {
  dayStart: number;
  events: LoadEvent[];
  /** 0 (overcast) … 1 (clear sky) */
  clearness: number;
  /** Heat-pump duty cycle 0..1 (0 in summer). */
  heatPumpDuty: number;
}

export interface HouseholdProfile {
  seed: number;
  /** EV wallbox power (W); 0 disables EV charging. */
  evW: number;
  /** Probability of an EV session per day. */
  evProbability: number;
  /** Heat pump electrical power (W); 0 disables it. */
  heatPumpW: number;
  /** Household appliance events (cooking, washing, …); false keeps only EV charging. Default true. */
  appliances?: boolean;
  timeZone: string;
}

export const DEFAULT_PROFILE: HouseholdProfile = {
  seed: 42,
  evW: 11_000,
  evProbability: 0.35,
  heatPumpW: 2_500,
  timeZone: 'Europe/Vienna',
};

const HEAT_PUMP_DUTY_BY_MONTH = [0.6, 0.5, 0.35, 0.2, 0.05, 0, 0, 0, 0.05, 0.2, 0.4, 0.55];

/** Deterministic plan of appliance events for the local day containing `ts`. */
export function dayPlan(ts: number, profile: HouseholdProfile): DayPlan {
  const tz = profile.timeZone;
  const dayStart = startOfLocalDay(ts, tz);
  const r = rng(hashString(`${profile.seed}:${dayKey(ts, tz)}`));
  const { weekday, month } = localParts(dayStart + 12 * HOUR_MS, tz);
  const weekend = weekday >= 5;
  const at = (h: number, jitterMin: number) =>
    dayStart + h * HOUR_MS + (r() - 0.5) * 2 * jitterMin * MINUTE_MS;
  const events: LoadEvent[] = [];
  const add = (name: string, start: number, minutes: number, watts: number) =>
    events.push({ name, start, end: start + minutes * MINUTE_MS, watts });

  if (r() < 0.8) add('kettle', at(6.75, 30), 4, 2_000);
  if (r() < (weekend ? 0.9 : 0.4)) add('stove', at(11.75, 30), 25 + r() * 20, 2_200 + r() * 800);
  if (r() < 0.9) {
    const s = at(18, 45);
    add('stove', s, 30 + r() * 20, 2_500 + r() * 1_000);
    if (r() < 0.5) add('oven', s + 5 * MINUTE_MS, 40, 2_200);
  }
  if (r() < 0.45) {
    const s = at(weekend ? 10 : 19, 60);
    add('washing machine', s, 20, 2_000);
    add('washing machine', s + 20 * MINUTE_MS, 70, 250);
    if (r() < 0.5) add('dryer', s + 100 * MINUTE_MS, 75, 2_400);
  }
  if (r() < 0.6) add('dishwasher', at(20.5, 45), 25, 2_000);
  if (profile.evW > 0 && r() < profile.evProbability) {
    add('EV charging', at(18.5, 90), 60 + r() * 150, profile.evW);
  }

  return {
    dayStart,
    // Filtered at the end so the random sequence (and other days' plans) stays identical.
    events: profile.appliances === false ? events.filter((e) => e.name === 'EV charging') : events,
    clearness: Math.min(1, Math.max(0.1, 0.25 + r() * 0.9)),
    heatPumpDuty: profile.heatPumpW > 0 ? (HEAT_PUMP_DUTY_BY_MONTH[month - 1] ?? 0) : 0,
  };
}
