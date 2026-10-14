import { HOUR_MS, MINUTE_MS, localParts } from '@peak-guard/core';
import { DEFAULT_PROFILE, dayPlan, type DayPlan, type HouseholdProfile } from './day-plan.js';
import { hashString, rng } from './rng.js';

export interface HouseConfig {
  profile: HouseholdProfile;
  /** PV peak power (Wp). */
  pvPeakW: number;
  latitudeDeg: number;
  /** Usable battery capacity (Wh); 0 = no battery. */
  batteryWh: number;
  /** Max charge / discharge power of the battery path (W) — SunSpec WChaMax. */
  batteryMaxW: number;
  /** Inverter-side minimum SoC (%), as configured in the Gen24 UI. */
  minSocPct: number;
  /** One-way battery efficiency. */
  efficiency: number;
  /** Whether the storage revert timer (InOutWRte_RvrtTms) is honoured. */
  revertSupported: boolean;
}

export const DEFAULT_HOUSE: HouseConfig = {
  profile: DEFAULT_PROFILE,
  pvPeakW: 10_000,
  latitudeDeg: 48.2,
  batteryWh: 10_240, // BYD Battery-Box Premium HVS 10.2
  batteryMaxW: 6_000,
  minSocPct: 5,
  efficiency: 0.96,
  revertSupported: true,
};

/** SunSpec model 124 control fields (values already scaled to real units). */
export interface StorageControl {
  /** bit0: charge limit active, bit1: discharge limit active */
  storCtlMod: number;
  /** % of WChaMax (−100..100). Negative = forced discharge. */
  inWRtePct: number;
  /** % of WChaMax (−100..100). Negative = forced charge. */
  outWRtePct: number;
  /** Revert timeout (s); 0 = never revert. */
  revertS: number;
  minReservePct: number;
  /** Simulation time of the last control write. */
  lastWriteTs: number | null;
}

export const DEFAULT_CONTROL: StorageControl = {
  storCtlMod: 0,
  inWRtePct: 100,
  outWRtePct: 100,
  revertS: 0,
  minReservePct: 5,
  lastWriteTs: null,
};

export interface HouseState {
  ts: number;
  loadW: number;
  pvW: number;
  /** + discharge, − charge */
  batteryW: number;
  /** + import, − export */
  gridW: number;
  socPct: number;
  importWh: number;
  exportWh: number;
  activeEvents: string[];
}

export interface Disturbance {
  /** Extra load (W) until `until`. */
  extraW: number;
  until: number;
  name: string;
}

/**
 * Household simulation: appliance loads, PV, a battery running the Gen24's
 * self-consumption logic with SunSpec model 124 limits, and a bidirectional meter.
 */
export class House {
  readonly config: HouseConfig;
  control: StorageControl = { ...DEFAULT_CONTROL };
  private state: HouseState;
  private plan: DayPlan | null = null;
  private cloud = 1;
  private readonly noise: () => number;
  private readonly disturbances: Disturbance[] = [];

  constructor(
    startTs: number,
    config: Partial<HouseConfig> = {},
    initial: Partial<HouseState> = {},
  ) {
    this.config = { ...DEFAULT_HOUSE, ...config };
    this.noise = rng(hashString(`noise:${this.config.profile.seed}`));
    this.state = {
      ts: startTs,
      loadW: 0,
      pvW: 0,
      batteryW: 0,
      gridW: 0,
      socPct: 50,
      importWh: 5_000_000,
      exportWh: 8_000_000,
      activeEvents: [],
      ...initial,
    };
    this.step(startTs);
  }

  get current(): HouseState {
    return this.state;
  }

  addDisturbance(d: Disturbance): void {
    this.disturbances.push(d);
  }

  /** Write model 124 control values (as the Modbus server would). */
  writeControl(patch: Partial<Omit<StorageControl, 'lastWriteTs'>>, ts: number): void {
    this.control = { ...this.control, ...patch, lastWriteTs: ts };
  }

  /** Advance to `ts`, integrating in steps of at most `maxStepMs`. */
  advanceTo(ts: number, maxStepMs = 1_000): HouseState {
    while (this.state.ts < ts) this.step(Math.min(ts, this.state.ts + maxStepMs));
    return this.state;
  }

  private step(ts: number): void {
    const dtH = (ts - this.state.ts) / HOUR_MS;
    const c = this.config;
    this.applyRevert(ts);

    const load = this.loadAt(ts);
    const pv = this.pvAt(ts);
    const battery = this.batteryPower(load.watts - pv, dtH);

    const grid = load.watts - pv - battery;
    const soc = this.state.socPct;
    let socNext = soc;
    if (c.batteryWh > 0 && dtH > 0) {
      const energy = battery > 0 ? battery / c.efficiency : battery * c.efficiency;
      socNext = Math.min(100, Math.max(0, soc - (energy * dtH * 100) / c.batteryWh));
    }
    this.state = {
      ts,
      loadW: load.watts,
      pvW: pv,
      batteryW: battery,
      gridW: grid,
      socPct: socNext,
      importWh: this.state.importWh + Math.max(0, grid) * dtH,
      exportWh: this.state.exportWh + Math.max(0, -grid) * dtH,
      activeEvents: load.active,
    };
  }

  private applyRevert(ts: number): void {
    const ctl = this.control;
    if (!this.config.revertSupported || ctl.revertS <= 0 || ctl.lastWriteTs == null) return;
    if (ctl.storCtlMod !== 0 && ts - ctl.lastWriteTs > ctl.revertS * 1_000) {
      this.control = {
        ...DEFAULT_CONTROL,
        minReservePct: ctl.minReservePct,
        lastWriteTs: ctl.lastWriteTs,
      };
    }
  }

  /** Battery power for a net demand (load − pv), + discharge / − charge. */
  private batteryPower(netW: number, dtH: number): number {
    const c = this.config;
    if (c.batteryWh <= 0) return 0;
    const ctl = this.control;
    const soc = this.state.socPct;
    const floor = Math.max(c.minSocPct, ctl.minReservePct);
    const maxW = c.batteryMaxW;

    let dischargeLimit = maxW;
    let chargeLimit = maxW;
    let forced = 0; // + forced discharge, − forced charge
    if (ctl.storCtlMod & 1) {
      if (ctl.inWRtePct < 0) forced = (-ctl.inWRtePct / 100) * maxW;
      else chargeLimit = (ctl.inWRtePct / 100) * maxW;
    }
    if (ctl.storCtlMod & 2) {
      if (ctl.outWRtePct < 0) forced = (ctl.outWRtePct / 100) * maxW;
      else dischargeLimit = (ctl.outWRtePct / 100) * maxW;
    }

    // Energy headroom within this step.
    const hours = Math.max(dtH, 1 / 3600);
    const availWh = Math.max(0, ((soc - floor) / 100) * c.batteryWh) * c.efficiency;
    const roomWh = Math.max(0, ((100 - soc) / 100) * c.batteryWh) / c.efficiency;
    const maxDis = Math.min(dischargeLimit, availWh / hours, maxW);
    const maxCha = Math.min(chargeLimit, roomWh / hours, maxW);

    if (forced > 0) return Math.min(forced, availWh / hours, maxW);
    if (forced < 0) return -Math.min(-forced, roomWh / hours, maxW);
    // Self-consumption: cover the deficit / absorb the surplus within limits.
    return netW > 0 ? Math.min(netW, maxDis) : -Math.min(-netW, maxCha);
  }

  private loadAt(ts: number): { watts: number; active: string[] } {
    if (!this.plan || ts < this.plan.dayStart || ts >= this.plan.dayStart + 25 * HOUR_MS) {
      this.plan = dayPlan(ts, this.config.profile);
    }
    const plan = this.plan;
    const { hour, minute } = localParts(ts, this.config.profile.timeZone);
    const h = hour + minute / 60;
    // Base load: night ~250 W, evening ~500 W, plus fridge cycling and noise.
    let watts =
      250 + 150 * Math.max(0, Math.sin(((h - 5) / 19) * Math.PI)) + (h > 17 && h < 23 ? 150 : 0);
    watts += Math.floor(ts / (20 * MINUTE_MS)) % 3 === 0 ? 90 : 0;
    watts += (this.noise() - 0.5) * 40;
    const active: string[] = [];
    for (const e of plan.events) {
      if (ts >= e.start && ts < e.end) {
        watts += e.watts;
        active.push(e.name);
      }
    }
    if (plan.heatPumpDuty > 0) {
      const cycle = 60 * MINUTE_MS;
      if ((ts - plan.dayStart) % cycle < plan.heatPumpDuty * cycle) {
        watts += this.config.profile.heatPumpW;
        active.push('heat pump');
      }
    }
    for (const d of this.disturbances) {
      if (ts < d.until) {
        watts += d.extraW;
        active.push(d.name);
      }
    }
    return { watts: Math.max(0, watts), active };
  }

  private pvAt(ts: number): number {
    const c = this.config;
    if (c.pvPeakW <= 0) return 0;
    const elevation = solarElevationDeg(ts, c.latitudeDeg);
    if (elevation <= 0) return 0;
    const clearSky = Math.pow(Math.sin((elevation * Math.PI) / 180), 1.2);
    // Cloud factor: slowly varying random walk around the day's clearness.
    const target = this.plan?.clearness ?? 0.8;
    this.cloud += (target - this.cloud) * 0.01 + (this.noise() - 0.5) * 0.05 * (1 - target);
    this.cloud = Math.min(1, Math.max(0.05, this.cloud));
    return c.pvPeakW * 0.85 * clearSky * this.cloud;
  }
}

/** Approximate solar elevation (degrees) for Central European longitudes (~15°E). */
export function solarElevationDeg(ts: number, latitudeDeg: number, longitudeDeg = 15.6): number {
  const d = new Date(ts);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (ts - start) / 86_400_000;
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (doy - 81));
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const solarTime = utcHours + longitudeDeg / 15;
  const hourAngle = (solarTime - 12) * 15;
  const rad = Math.PI / 180;
  const sinEl =
    Math.sin(latitudeDeg * rad) * Math.sin(decl * rad) +
    Math.cos(latitudeDeg * rad) * Math.cos(decl * rad) * Math.cos(hourAngle * rad);
  return Math.asin(sinEl) / rad;
}
