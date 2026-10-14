import { shedStep, type ShedState } from '@peak-guard/core';
import type { HookAction, LiveSnapshot, Settings } from '@peak-guard/shared';
import type { Logger } from 'pino';

export interface ShedderDeps {
  getSettings: () => Settings;
  log: Logger;
  record?: (kind: string, message: string, data?: unknown) => Promise<void>;
  /** MQTT sender (null when MQTT is not configured). */
  mqttSend?: ((topic: string, payload: string, retain: boolean) => Promise<void>) | null;
  fetch?: typeof fetch;
}

/** Executes the load-shedding hooks from the live snapshot. */
export class LoadShedder {
  private readonly state = new Map<string, ShedState>();
  private busy = false;

  constructor(private readonly deps: ShedderDeps) {}

  /** Names of hooks currently shedding. */
  get active(): string[] {
    const rules = this.deps.getSettings().loadShedding;
    return rules.filter((r) => this.state.get(r.id)?.active).map((r) => r.name);
  }

  /** Evaluate all hooks against a snapshot (serialized; never throws). */
  async evaluate(s: LiveSnapshot, now = s.ts): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = this.deps.getSettings();
      const targetKw =
        s.control?.targetKw ??
        Math.max(s.effectiveLimitKw, settings.control.adaptive ? (s.monthPeak?.kw ?? 0) : 0);
      for (const rule of settings.loadShedding) {
        const st = this.state.get(rule.id) ?? { active: false, since: null };
        if (!rule.enabled) {
          if (st.active)
            await this.run(rule.id, rule.name, 'restore', rule.restore, now, 'hook disabled');
          continue;
        }
        const action = shedStep(
          {
            triggerRatio: rule.triggerRatio,
            releaseRatio: rule.releaseRatio,
            minOnMs: rule.minOnMinutes * 60_000,
            maxOnMs: rule.maxOnMinutes * 60_000,
            minOffMs: rule.minOffMinutes * 60_000,
          },
          st,
          { now, projectedKw: s.interval.projectedKw, targetKw, elapsedMs: s.interval.elapsedMs },
        );
        if (action) {
          const why = `projected ${s.interval.projectedKw.toFixed(2)} kW, target ${targetKw.toFixed(1)} kW`;
          await this.run(
            rule.id,
            rule.name,
            action,
            action === 'shed' ? rule.shed : rule.restore,
            now,
            why,
          );
        }
      }
      // Hooks removed from the settings while shedding: forget them (their restore is unknown).
      for (const id of this.state.keys())
        if (!settings.loadShedding.some((r) => r.id === id)) this.state.delete(id);
    } finally {
      this.busy = false;
    }
  }

  /** Restore every shed load (shutdown). */
  async restoreAll(now = Date.now()): Promise<void> {
    for (const rule of this.deps.getSettings().loadShedding) {
      if (this.state.get(rule.id)?.active)
        await this.run(rule.id, rule.name, 'restore', rule.restore, now, 'shutdown');
    }
  }

  private async run(
    id: string,
    name: string,
    action: 'shed' | 'restore',
    a: HookAction,
    now: number,
    why: string,
  ): Promise<void> {
    try {
      if (a.type === 'webhook') {
        const res = await (this.deps.fetch ?? fetch)(a.url, {
          method: a.method,
          ...(a.method !== 'GET' && a.body
            ? { body: a.body, headers: { 'content-type': guessType(a.body) } }
            : {}),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        if (!this.deps.mqttSend) throw new Error('MQTT is not configured (MQTT_URL)');
        await this.deps.mqttSend(a.topic, a.payload, a.retain);
      }
      // State changes only after the action succeeded; a failed shed is retried next tick.
      this.state.set(id, { active: action === 'shed', since: now });
      this.deps.log.info({ hook: name, action, why }, 'load-shedding hook');
      await this.deps.record?.('load_shed', `${name}: ${action} (${why})`).catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ hook: name, action, err: msg }, 'load-shedding hook failed');
      await this.deps
        .record?.('load_shed_error', `${name}: ${action} failed: ${msg}`)
        .catch(() => {});
    }
  }
}

function guessType(body: string): string {
  const t = body.trim();
  return t.startsWith('{') || t.startsWith('[') ? 'application/json' : 'text/plain';
}
