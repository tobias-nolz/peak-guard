import { decide, type ControlDecision } from '@peak-guard/core';
import { addEvent, insertDecisions, kvSet, type Db, type DecisionRow } from '@peak-guard/db';
import {
  STORAGE_DEFAULTS,
  discoverModels,
  readStorage,
  writeStorage,
  type ModbusTransport,
  type ModelInfo,
  type StorageCommand,
  type StorageState,
} from '@peak-guard/fronius';
import type { LiveSnapshot, Settings } from '@peak-guard/shared';
import type { Logger } from 'pino';
import { commandFor, significantChange } from './mapping.js';

export interface ControllerDeps {
  db: Db;
  log: Logger;
  getSettings: () => Settings;
  /** null when MODBUS_ENABLED=false */
  transport: ModbusTransport | null;
  /** CONTROL_WRITES_ENABLED kill switch */
  writesEnabled: boolean;
  modbusPollMs: number;
  now: () => number;
  /** Sleep and wall clock for the revert test (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  wallClock?: () => number;
}

export interface ControlInputs {
  /** Interval start/elapsed and energy so far (calibrated). */
  elapsedMs: number;
  importWh: number;
  /** Smoothed grid power (calibrated W). */
  gridW: number;
  batteryW: number | null;
  /** SoC from the Solar API (fallback when Modbus is off). */
  socPct: number | null;
  monthPeakKw: number | null;
}

export type RevertTestStatus = 'running' | 'passed' | 'failed';

export interface RevertTestResult {
  status: RevertTestStatus;
  startedAt: number;
  finishedAt: number | null;
  /** Seconds until the inverter reverted (passed only). */
  revertAfterS: number | null;
  message: string;
}

export type ModbusState = 'disabled' | 'ok' | 'error';

/** Decisions are logged when they change, and at least this often. */
const LOG_EVERY_MS = 15_000;
const STATUS_EVERY_MS = 5_000;

/**
 * Peak-shaving controller (I/O shell around decide()).
 *
 * M7 scope: Modbus readout and dry-run — decisions and the command that *would* be
 * written are logged, nothing is written except by the explicit revert self-test (which
 * also requires CONTROL_WRITES_ENABLED).
 */
export class Controller {
  private model: ModelInfo | null = null;
  private storage: StorageState | null = null;
  private storageAt = 0;
  private modbus: ModbusState;
  private modbusError: string | null = null;
  private decision: (ControlDecision & { ts: number }) | null = null;
  private command: StorageCommand | null = null;
  private lastLogged: { ts: number; decision: string; command: StorageCommand | null } | null =
    null;
  private pending: DecisionRow[] = [];
  private lastStatusAt = 0;
  private revert: RevertTestResult | null = null;
  private busy = false;
  private note: string | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.modbus = deps.transport ? 'error' : 'disabled';
  }

  get revertTest(): RevertTestResult | null {
    return this.revert;
  }

  /** Compact state for the live snapshot. */
  snapshotPart(): NonNullable<LiveSnapshot['control']> {
    const s = this.deps.getSettings().control;
    return {
      mode: s.mode,
      writesEnabled: this.deps.writesEnabled,
      modbus: this.modbus,
      decision: this.decision?.mode ?? null,
      targetKw: this.decision?.targetKw ?? null,
      limitW: this.decision?.dischargeLimitW ?? null,
      requiredW: this.decision?.requiredW ?? null,
      storCtlMod: this.storage?.storCtlMod ?? null,
      outWRtePct: this.storage?.outWRtePct ?? null,
      note: this.note,
    };
  }

  private async refreshStorage(force = false): Promise<void> {
    const t = this.deps.transport;
    if (!t) return;
    const now = Date.now();
    if (!force && now - this.storageAt < this.deps.modbusPollMs) return;
    this.storageAt = now;
    try {
      if (!this.model) {
        const model = (await discoverModels(t)).find((m) => m.id === 124);
        if (!model)
          throw new Error(
            'inverter exposes no SunSpec storage model (124) — battery not detected?',
          );
        this.model = model;
        this.deps.log.info({ address: model.address }, 'SunSpec storage model 124 found');
      }
      this.storage = await readStorage(t, this.model);
      if (this.modbus !== 'ok') {
        this.deps.log.info({ storage: this.storage }, 'Modbus connection ok');
        await addEvent(this.deps.db, 'modbus', 'Modbus connection established', {
          storage: this.storage,
        }).catch(() => {});
      }
      this.modbus = 'ok';
      this.modbusError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.modbus !== 'error' || this.modbusError !== msg) {
        this.deps.log.warn({ err: msg }, 'Modbus read failed');
        await addEvent(this.deps.db, 'modbus', `Modbus error: ${msg}`).catch(() => {});
      }
      this.modbus = 'error';
      this.modbusError = msg;
      this.model = null; // rediscover after errors (e.g. inverter restart)
    }
  }

  async tick(i: ControlInputs): Promise<void> {
    const settings = this.deps.getSettings();
    const cfg = settings.control;
    await this.refreshStorage();
    if (cfg.mode === 'off') {
      this.decision = null;
      this.command = null;
      this.note = null;
      await this.publishStatus();
      return;
    }

    const maxW = this.storage?.wChaMaxW ?? (settings.battery.maxPowerKw ?? 0) * 1000;
    const soc = this.storage?.chaStatePct ?? i.socPct;
    if (!(maxW > 0) || soc == null) {
      this.note = !(maxW > 0)
        ? 'battery power unknown (enable Modbus or set it in Settings)'
        : 'battery SoC unknown';
      this.decision = null;
      await this.publishStatus();
      return;
    }
    this.note = null;
    const minBilledKw = settings.tariffs[0]?.minBilledKw ?? 0;
    const decision = decide(
      {
        elapsedMs: i.elapsedMs,
        importWh: i.importWh,
        gridW: i.gridW,
        batteryW: i.batteryW ?? 0,
        socPct: soc,
        monthPeakKw: i.monthPeakKw,
      },
      {
        thresholdKw: settings.thresholdKw,
        minBilledKw,
        adaptive: cfg.adaptive,
        marginKw: cfg.marginKw,
        reservePct: cfg.reservePct,
        minSocPct: settings.battery.minSocPct,
        maxDischargeW: maxW,
      },
    );
    const now = this.deps.now();
    this.decision = { ...decision, ts: now };
    const next = commandFor(decision, maxW, cfg.revertTimeoutS);
    // Dry-run: the command we would write, with the same hysteresis as active mode.
    if (significantChange(this.command, next, cfg.minChangeW, maxW)) this.command = next;

    const changed =
      !this.lastLogged ||
      this.lastLogged.decision !== decision.mode ||
      this.lastLogged.command !== this.command ||
      now - this.lastLogged.ts >= LOG_EVERY_MS;
    if (changed) {
      this.pending.push({
        ts: now,
        controllerMode: cfg.mode,
        decision: decision.mode,
        targetKw: decision.targetKw,
        requiredW: decision.requiredW,
        limitW: decision.dischargeLimitW,
        projectedKw: decision.projectedKw,
        gridW: i.gridW,
        batteryW: i.batteryW,
        socPct: soc,
        storCtlMod: this.command?.storCtlMod ?? null,
        outWRtePct: this.command?.outWRtePct ?? null,
        applied: false,
        note: cfg.mode === 'active' ? 'active control not implemented yet (M8): dry-run' : null,
      });
      this.lastLogged = { ts: now, decision: decision.mode, command: this.command };
    }
    await this.flush();
    await this.publishStatus();
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    try {
      await insertDecisions(this.deps.db, rows);
    } catch (err) {
      this.pending = [...rows, ...this.pending].slice(-10_000);
      this.deps.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to write decisions',
      );
    }
  }

  private async publishStatus(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastStatusAt < STATUS_EVERY_MS) return;
    this.lastStatusAt = now;
    await kvSet(this.deps.db, 'control.status', {
      ts: now,
      mode: this.deps.getSettings().control.mode,
      writesEnabled: this.deps.writesEnabled,
      modbus: {
        state: this.modbus,
        error: this.modbusError,
        storage: this.storage,
        model: this.model,
      },
      decision: this.decision,
      command: this.command,
      note: this.note,
      revertTest: this.revert,
    }).catch(() => {});
  }

  /**
   * Revert self-test: write a harmless limit (discharge limit at 100 % — no effect on
   * the battery) with a short revert timeout, stop writing, and watch whether the
   * inverter reverts StorCtl_Mod to 0 by itself.
   */
  async runRevertTest(revertS = 60): Promise<RevertTestResult> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const clock = this.deps.wallClock ?? Date.now;
    const t = this.deps.transport;
    const result = (
      status: RevertTestStatus,
      message: string,
      revertAfterS: number | null = null,
    ): RevertTestResult => ({
      status,
      startedAt: this.revert?.startedAt ?? clock(),
      finishedAt: status === 'running' ? null : clock(),
      revertAfterS,
      message,
    });
    const finish = async (r: RevertTestResult) => {
      this.revert = r;
      this.busy = false;
      await addEvent(
        this.deps.db,
        'revert_test',
        `Revert self-test ${r.status}: ${r.message}`,
        r,
      ).catch(() => {});
      await this.publishStatus(true);
      return r;
    };

    if (this.busy) return result('failed', 'a revert test is already running');
    this.revert = {
      status: 'running',
      startedAt: clock(),
      finishedAt: null,
      revertAfterS: null,
      message: 'starting',
    };
    this.busy = true;
    if (!t) return finish(result('failed', 'Modbus is disabled (MODBUS_ENABLED=false)'));
    if (!this.deps.writesEnabled)
      return finish(result('failed', 'writes are disabled (CONTROL_WRITES_ENABLED=false)'));

    await this.refreshStorage(true);
    if (!this.storage || !this.model)
      return finish(result('failed', `Modbus not available: ${this.modbusError ?? 'unknown'}`));
    const probe: StorageCommand = {
      storCtlMod: 2,
      outWRtePct: 100,
      inWRtePct: 100,
      rvrtTmsS: revertS,
    };
    try {
      await writeStorage(t, probe, this.storage);
    } catch (err) {
      return finish(
        result(
          'failed',
          `write rejected: ${err instanceof Error ? err.message : String(err)} — is "Inverter control via Modbus" enabled?`,
        ),
      );
    }
    const writtenAt = clock();
    let s = await readStorage(t, this.model);
    if (s.storCtlMod !== 2 || s.rvrtTmsS !== revertS) {
      await writeStorage(t, STORAGE_DEFAULTS, s).catch(() => {});
      return finish(
        result(
          'failed',
          `write not applied (read back StorCtl_Mod=${s.storCtlMod}, RvrtTms=${s.rvrtTmsS})`,
        ),
      );
    }
    this.revert = {
      ...this.revert,
      message: `waiting up to ${revertS + 45} s for the inverter to revert`,
    };
    await this.publishStatus(true);
    // Only read from now on — writes would restart the timer.
    while (clock() - writtenAt < (revertS + 45) * 1000) {
      await sleep(5_000);
      try {
        s = await readStorage(t, this.model);
      } catch {
        continue;
      }
      if (s.storCtlMod === 0) {
        const after = Math.round((clock() - writtenAt) / 1000);
        return finish(
          result('passed', `inverter reverted to its own mode after ~${after} s`, after),
        );
      }
    }
    // Not reverted: restore defaults ourselves and verify.
    try {
      await writeStorage(t, STORAGE_DEFAULTS, s);
      s = await readStorage(t, this.model);
    } catch {
      /* reported below */
    }
    return finish(
      result(
        'failed',
        `inverter did NOT revert within ${revertS + 45} s — the storage revert timer is not supported by this firmware; ` +
          `defaults ${s.storCtlMod === 0 ? 'restored' : 'could NOT be restored (check the inverter!)'}`,
      ),
    );
  }

  async close(): Promise<void> {
    await this.flush();
    await this.deps.transport?.close();
  }
}
