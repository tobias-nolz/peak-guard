import { decide, type ControlDecision } from '@peak-guard/core';
import { addEvent, insertDecisions, kvGet, kvSet, type Db, type DecisionRow } from '@peak-guard/db';
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
import { WRITES_DISABLED_MESSAGE, type LiveSnapshot, type Settings } from '@peak-guard/shared';
import type { Logger } from 'pino';
import type { Notification } from '../notify/notifier.js';
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
  /** Measurement time (inverter clock with the accelerated mock). */
  now: () => number;
  /** Wall clock for the watchdog and the revert test (injectable for tests). */
  wallClock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** No tick for this long (wall clock) while limits are active → restore defaults. */
  staleAfterMs?: number;
  /** Notifications for safety-relevant events. */
  alert?: (n: Notification, dedupeKey?: string) => void;
}

export interface ControlInputs {
  /** Interval elapsed time and import energy so far (calibrated). */
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
/** Consecutive failed writes/verifications before control is latched off. */
const MAX_FAILURES = 3;
const REVERT_KV = 'control.revertTest';

const sameCommand = (a: StorageCommand | null, b: StorageCommand | null) =>
  !!a &&
  !!b &&
  a.storCtlMod === b.storCtlMod &&
  (a.storCtlMod === 0 ||
    (Math.abs(a.outWRtePct - b.outWRtePct) < 0.01 && a.inWRtePct === b.inWRtePct));

/**
 * Peak-shaving controller: the I/O shell around decide().
 *
 * Dry-run logs what it would do. Active writes model 124 discharge limits — only when the
 * kill switch allows writes, Modbus works, the revert self-test passed (or was explicitly
 * acknowledged), control isn't paused and no fault is latched. Every write is read back
 * and verified; on any problem, and on shutdown, mode changes and stale data, the
 * inverter's own mode is restored (StorCtl_Mod = 0). Limits are re-written before the
 * inverter-side revert timeout expires (keep-alive).
 */
export class Controller {
  private model: ModelInfo | null = null;
  private storage: StorageState | null = null;
  private storageAt = 0;
  private modbus: ModbusState;
  private modbusError: string | null = null;
  private decision: (ControlDecision & { ts: number }) | null = null;
  /** Command for dry-run comparison (with hysteresis), also what active mode wants. */
  private desired: StorageCommand | null = null;
  /** Last command written *and verified* at the inverter; null = unknown. */
  private written: StorageCommand | null = null;
  private lastWriteAt = -Infinity;
  private failures = 0;
  private fault: string | null = null;
  private pausedUntil: number | null = null;
  private lastTickWall = 0;
  private lastMode: string | null = null;
  private lastLogged: {
    ts: number;
    decision: string;
    command: StorageCommand | null;
    applied: boolean;
  } | null = null;
  private pending: DecisionRow[] = [];
  private lastStatusAt = 0;
  private revert: RevertTestResult | null = null;
  private busy = false;
  private note: string | null = null;
  private applying = false;

  constructor(private readonly deps: ControllerDeps) {
    this.modbus = deps.transport ? 'error' : 'disabled';
  }

  private wall(): number {
    return (this.deps.wallClock ?? Date.now)();
  }

  get revertTest(): RevertTestResult | null {
    return this.revert;
  }

  /** Load persisted state and put the inverter into its own mode (safe start). */
  async init(): Promise<void> {
    this.revert = await kvGet<RevertTestResult>(this.deps.db, REVERT_KV).catch(() => null);
    if (this.revert?.status === 'running') this.revert = null; // interrupted by a restart
    await this.refreshStorage(true);
    if (this.deps.writesEnabled && this.storage && this.storage.storCtlMod !== 0) {
      await this.restoreDefaults('startup: limits left from a previous run');
    }
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
      applying: this.applying,
    };
  }

  /** Pause active control until the given wall-clock time (null = resume). */
  async pause(untilWall: number | null): Promise<void> {
    this.pausedUntil = untilWall;
    await addEvent(
      this.deps.db,
      'control_pause',
      untilWall ? `Control paused until ${new Date(untilWall).toISOString()}` : 'Control resumed',
    ).catch(() => {});
    if (untilWall) await this.restoreDefaults('paused');
    await this.publishStatus(true);
  }

  /** Clear a latched fault (e.g. after the user fixed the cause). */
  clearFault(): void {
    this.fault = null;
    this.failures = 0;
  }

  private async refreshStorage(force = false): Promise<void> {
    const t = this.deps.transport;
    if (!t) return;
    const now = this.wall();
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

  /** Why active control can't write right now (null = it can). */
  private blockedReason(settings: Settings): string | null {
    if (!this.deps.writesEnabled) return WRITES_DISABLED_MESSAGE;
    if (!this.deps.transport) return 'Modbus disabled (MODBUS_ENABLED=false)';
    if (this.modbus !== 'ok' || !this.storage)
      return `Modbus unavailable${this.modbusError ? `: ${this.modbusError}` : ''}`;
    if (this.revert?.status !== 'passed' && !settings.control.acknowledgeNoRevert)
      return 'revert self-test not passed';
    if (this.fault) return `fault: ${this.fault}`;
    if (this.busy) return 'revert self-test running';
    if (this.pausedUntil && this.wall() < this.pausedUntil) {
      return `paused until ${new Date(this.pausedUntil).toISOString()}`;
    }
    return null;
  }

  async tick(i: ControlInputs): Promise<void> {
    const settings = this.deps.getSettings();
    const cfg = settings.control;
    this.lastTickWall = this.wall();
    if (this.pausedUntil && this.wall() >= this.pausedUntil) this.pausedUntil = null;
    await this.refreshStorage();

    if (cfg.mode !== this.lastMode) {
      if (this.lastMode === 'active' || (this.written && this.written.storCtlMod !== 0)) {
        await this.restoreDefaults(`mode changed to ${cfg.mode}`);
      }
      if (cfg.mode === 'active') this.clearFault();
      this.lastMode = cfg.mode;
    }
    if (cfg.mode === 'off') {
      this.decision = null;
      this.desired = null;
      this.note = null;
      this.applying = false;
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
      this.applying = false;
      if (this.written && this.written.storCtlMod !== 0) await this.restoreDefaults(this.note);
      await this.publishStatus();
      return;
    }

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
        minBilledKw: settings.tariffs[0]?.minBilledKw ?? 0,
        adaptive: cfg.adaptive,
        marginKw: cfg.marginKw,
        reservePct: cfg.reservePct,
        minSocPct: settings.battery.minSocPct,
        maxDischargeW: maxW,
      },
    );
    const now = this.deps.now();
    if (decision.mode === 'empty' && this.decision?.mode === 'shave') {
      this.deps.alert?.({
        kind: 'reserveDepleted',
        title: 'Battery reserve depleted',
        message: `The reserve ran empty while shaving (target ${decision.targetKw.toFixed(1)} kW). The quarter-hour may exceed the target.`,
        urgent: true,
      });
    }
    this.decision = { ...decision, ts: now };
    const next = commandFor(decision, maxW, cfg.revertTimeoutS);
    if (significantChange(this.desired, next, cfg.minChangeW, maxW)) this.desired = next;

    let wrote = false;
    this.note = null;
    if (cfg.mode === 'active') {
      const blocked = this.blockedReason(settings);
      if (blocked) {
        this.note = `active blocked: ${blocked}`;
        if (this.written && this.written.storCtlMod !== 0 && !this.busy) {
          await this.restoreDefaults(blocked, /^(Modbus|fault)/.test(blocked));
        }
      } else {
        wrote = await this.apply(this.desired!, now, cfg.minUpdateIntervalS, cfg.revertTimeoutS);
      }
    }
    this.applying = cfg.mode === 'active' && !this.note && sameCommand(this.written, this.desired);

    const changed =
      !this.lastLogged ||
      wrote ||
      this.lastLogged.decision !== decision.mode ||
      this.lastLogged.command !== this.desired ||
      this.lastLogged.applied !== this.applying ||
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
        storCtlMod: this.desired?.storCtlMod ?? null,
        outWRtePct: this.desired?.outWRtePct ?? null,
        applied: this.applying,
        note: this.note,
      });
      this.lastLogged = {
        ts: now,
        decision: decision.mode,
        command: this.desired,
        applied: this.applying,
      };
    }
    await this.flush();
    await this.publishStatus();
  }

  /** Bring the inverter to `cmd` (rate-limited, with keep-alive). Returns true if written. */
  private async apply(
    cmd: StorageCommand,
    now: number,
    minUpdateS: number,
    revertS: number,
  ): Promise<boolean> {
    const sinceWrite = now - this.lastWriteAt;
    const keepAliveDue =
      !!this.written &&
      this.written.storCtlMod !== 0 &&
      sinceWrite >= Math.max(10, revertS / 3) * 1000;
    const differs = !sameCommand(this.written, cmd);
    if (!differs && !keepAliveDue) return false;
    // Releasing the battery (inverter's own mode) is always safe and immediate; other
    // changes respect the minimum interval (keep-alive rewrites the current command).
    if (differs && cmd.storCtlMod !== 0 && this.written && sinceWrite < minUpdateS * 1000) {
      if (!keepAliveDue) return false;
      return this.write(this.written, now, 'keep-alive');
    }
    return this.write(differs ? cmd : this.written!, now, differs ? 'setpoint' : 'keep-alive');
  }

  /** Write a command, read it back and verify. Failures restore defaults; repeated ones latch a fault. */
  private async write(cmd: StorageCommand, now: number, why: string): Promise<boolean> {
    const t = this.deps.transport;
    if (!t || !this.model || !this.storage) return false;
    try {
      await writeStorage(t, cmd, this.storage);
      const back = await readStorage(t, this.model);
      this.storage = back;
      const ok =
        back.storCtlMod === cmd.storCtlMod &&
        (cmd.storCtlMod === 0 ||
          (back.outWRtePct != null && Math.abs(back.outWRtePct - cmd.outWRtePct) < 0.05));
      if (!ok)
        throw new Error(
          `verification failed: read back StorCtl_Mod=${back.storCtlMod}, OutWRte=${back.outWRtePct}`,
        );
      this.written = cmd;
      this.lastWriteAt = now;
      this.failures = 0;
      this.deps.log.debug({ cmd, why }, 'storage command written');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failures++;
      this.written = null;
      this.deps.log.error({ err: msg, cmd, failures: this.failures }, 'storage write failed');
      await addEvent(
        this.deps.db,
        'control_error',
        `Write failed (${this.failures}/${MAX_FAILURES}): ${msg}`,
      ).catch(() => {});
      if (cmd.storCtlMod !== 0) await this.restoreDefaults(`write failed: ${msg}`, true);
      if (this.failures >= MAX_FAILURES) {
        this.fault = `${MAX_FAILURES} consecutive write failures (${msg})`;
        this.deps.alert?.({
          kind: 'controlSafeMode',
          title: 'Peak shaving stopped',
          message: `Active control latched a fault: ${this.fault}. The inverter runs its own mode until the fault is reset.`,
          urgent: true,
        });
        await addEvent(
          this.deps.db,
          'control_fault',
          `Active control stopped: ${this.fault}`,
        ).catch(() => {});
      }
      return false;
    }
  }

  /**
   * Put the inverter back into its own mode (best effort, never throws). `alert` for
   * error-caused fallbacks (not for user actions like mode changes or pauses).
   */
  async restoreDefaults(reason: string, alert = false): Promise<boolean> {
    if (alert) {
      this.deps.alert?.(
        {
          kind: 'controlSafeMode',
          title: 'Peak shaving fell back to the inverter mode',
          message: `Reason: ${reason}`,
          urgent: true,
        },
        reason.slice(0, 40),
      );
    }
    const t = this.deps.transport;
    if (!t || !this.deps.writesEnabled) return false;
    try {
      if (!this.model) this.model = (await discoverModels(t)).find((m) => m.id === 124) ?? null;
      if (!this.model) return false;
      const state = this.storage ?? (await readStorage(t, this.model));
      await writeStorage(t, STORAGE_DEFAULTS, state);
      this.storage = await readStorage(t, this.model);
      const ok = this.storage.storCtlMod === 0;
      this.written = ok ? STORAGE_DEFAULTS : null;
      this.lastWriteAt = this.deps.now();
      this.deps.log.warn({ reason, ok }, 'inverter defaults restored');
      await addEvent(this.deps.db, 'control_revert', `Inverter defaults restored (${reason})`, {
        ok,
      }).catch(() => {});
      return ok;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.written = null;
      this.deps.log.error({ err: msg, reason }, 'could not restore inverter defaults');
      await addEvent(
        this.deps.db,
        'control_error',
        `Could not restore defaults (${reason}): ${msg}`,
      ).catch(() => {});
      return false;
    }
  }

  /**
   * Watchdog, called periodically by the host (wall clock). If ticks stop while limits
   * are active (no fresh data, stuck loop), restore the inverter's own mode.
   */
  async watchdog(): Promise<void> {
    const staleMs = this.deps.staleAfterMs ?? 30_000;
    if (
      this.written &&
      this.written.storCtlMod !== 0 &&
      this.wall() - this.lastTickWall > staleMs
    ) {
      this.note = 'watchdog: no fresh data';
      this.applying = false;
      await this.restoreDefaults(
        `watchdog: no control tick for ${Math.round((this.wall() - this.lastTickWall) / 1000)} s`,
        true,
      );
    }
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
    // Throttles DB writes only, so real time (not the injectable control clock).
    const now = Date.now();
    if (!force && now - this.lastStatusAt < STATUS_EVERY_MS) return;
    this.lastStatusAt = now;
    await kvSet(this.deps.db, 'control.status', {
      ts: Date.now(),
      mode: this.deps.getSettings().control.mode,
      writesEnabled: this.deps.writesEnabled,
      modbus: {
        state: this.modbus,
        error: this.modbusError,
        storage: this.storage,
        model: this.model,
      },
      decision: this.decision,
      command: this.desired,
      written: this.written,
      applying: this.applying,
      fault: this.fault,
      pausedUntil: this.pausedUntil,
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
    const clock = () => this.wall();
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
      await kvSet(this.deps.db, REVERT_KV, r).catch(() => {});
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
    if (!this.deps.writesEnabled) return finish(result('failed', WRITES_DISABLED_MESSAGE));

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
    this.written = null;
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
        this.storage = s;
        return finish(
          result('passed', `inverter reverted to its own mode after ~${after} s`, after),
        );
      }
    }
    // Not reverted: restore defaults ourselves and verify.
    try {
      await writeStorage(t, STORAGE_DEFAULTS, s);
      s = await readStorage(t, this.model);
      this.storage = s;
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

  /** Flush the log and leave the inverter in its own mode. */
  async close(): Promise<void> {
    await this.flush();
    const limited =
      (this.written && this.written.storCtlMod !== 0) ||
      (this.storage && this.storage.storCtlMod !== 0);
    if (limited) await this.restoreDefaults('shutdown');
    await this.deps.transport?.close();
  }
}
