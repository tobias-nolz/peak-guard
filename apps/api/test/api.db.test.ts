/**
 * HTTP-level tests against a real TimescaleDB (TEST_DATABASE_URL, admin URL). A separate
 * database `peakguard_api_test` is (re)created for the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { INTERVAL_MS, type ClosedInterval } from '@peak-guard/core';
import {
  createDb,
  insertSamples,
  kvSet,
  migrateDb,
  refreshMinuteAggregate,
  upsertIntervals,
  type Db,
  type Sql,
} from '@peak-guard/db';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { buildApp } from '../src/app.js';
import { apiEnvSchema } from '../src/config.js';
import { LiveHub } from '../src/live-hub.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const JAN = Date.parse('2026-12-31T23:00:00Z'); // 2027-01-01 00:00 Vienna
const PEAK = JAN + 4 * 86_400_000 + 18 * 3_600_000; // 5 Jan 18:00 local

const iv = (
  start: number,
  kw: number,
  quality: ClosedInterval['quality'] = 'exact',
): ClosedInterval => ({
  start,
  importWh: kw * 250,
  exportWh: 0,
  avgImportKw: kw,
  avgExportKw: 0,
  completeness: 1,
  quality,
  source: 'counter',
  sampleCount: 450,
  maxImportW: kw * 1200,
  integratedImportWh: kw * 250,
});

describe.skipIf(!adminUrl)('API ↔ TimescaleDB', () => {
  let sql: Sql;
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS peakguard_api_test WITH (FORCE)');
    await admin.unsafe('CREATE DATABASE peakguard_api_test');
    await admin.end();
    const u = new URL(adminUrl!);
    u.pathname = '/peakguard_api_test';
    await migrateDb(u.toString());
    ({ sql, db } = createDb(u.toString()));

    // One week of quarter-hours at 2 kW, a 12.4 kW EV peak and a missing interval.
    const rows: ClosedInterval[] = [];
    for (let t = JAN; t < JAN + 7 * 86_400_000; t += INTERVAL_MS) rows.push(iv(t, 2));
    rows.push(iv(PEAK, 12.4), iv(PEAK + INTERVAL_MS, 30, 'missing'));
    await upsertIntervals(db, rows);
    // Raw samples for the peak: EV at 11 kW with an empty battery.
    const samples = Array.from({ length: 90 }, (_, i) => ({
      ts: PEAK + i * 10_000,
      gridW: 12_400,
      loadW: 12_400,
      pvW: 0,
      batteryW: 0,
      socPct: 5,
      importWh: 1e6 + i * 34,
      exportWh: 5e5,
    }));
    await insertSamples(db, samples);
    await refreshMinuteAggregate(sql);

    app = await buildApp({
      env: apiEnvSchema.parse({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'error' }),
      db,
      sql,
      hub: new LiveHub(),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it('summarizes a month with the peak and its likely cause', async () => {
    const res = await app.inject('/api/months/2027-01?top=3');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      peak: { kw: number; start: number };
      billedKw: number;
      costEur: number;
      top: { kw: number; causes: string[]; flows: { socEnd: number } | null }[];
      quality: Record<string, number>;
    }>();
    expect(body.peak).toEqual({ kw: 12.4, start: PEAK });
    expect(body.billedKw).toBe(12.4);
    expect(body.top[0]!.causes).toEqual(['battery_empty', 'sustained_load']);
    expect(body.top[0]!.flows?.socEnd).toBe(5);
    expect(body.top[1]!.causes).toEqual([]); // no samples → no analysis
    expect(body.quality.missing).toBe(1);
  });

  it('rejects malformed months and ranges', async () => {
    expect((await app.inject('/api/months/2027-13')).statusCode).toBe(400);
    const r = await app.inject(`/api/intervals?from=${JAN}&to=${JAN - 1}`);
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toMatch(/after/);
  });

  it('returns the year overview', async () => {
    const body = (await app.inject('/api/years/2027')).json<{
      months: { month: string; peakKw: number | null }[];
    }>();
    expect(body.months).toHaveLength(12);
    expect(body.months[0]).toMatchObject({ month: '2027-01', peakKw: 12.4 });
    expect(body.months[1]!.peakKw).toBeNull();
  });

  it('analyzes the distribution of a range', async () => {
    const body = (await app.inject(`/api/analysis?from=${JAN}&to=${JAN + 7 * 86_400_000}`)).json<{
      count: number;
      maxKw: number;
      aboveLimit: number;
      heatmap: unknown[];
      duration: { pct: number; kw: number }[];
    }>();
    expect(body.count).toBe(7 * 96 - 1); // the missing interval is excluded
    expect(body.maxKw).toBe(12.4);
    expect(body.aboveLimit).toBe(1);
    expect(body.heatmap).toHaveLength(168);
    expect(body.duration[0]).toMatchObject({ kw: 12.4 });
  });

  it('exports intervals as CSV with local time', async () => {
    const res = await app.inject(`/api/export/intervals?from=${PEAK}&to=${PEAK + 2 * INTERVAL_MS}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="peak-guard-intervals_/,
    );
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toMatch(/^start_utc,start_local,avg_import_kw/);
    expect(lines[1]).toMatch(
      /^2027-01-05T17:00:00.000Z,2027-01-05 18:00:00,12.4000,12.4000,3.1000/,
    );
    expect(lines).toHaveLength(3);
  });

  it('serves the power series at 1-minute resolution', async () => {
    const body = (
      await app.inject(`/api/series?from=${PEAK}&to=${PEAK + INTERVAL_MS}&resolution=60`)
    ).json<{
      resolutionS: number;
      points: number[][];
    }>();
    expect(body.resolutionS).toBe(60);
    expect(body.points).toHaveLength(15);
    expect(body.points[0]![1]).toBe(12_400);
  });

  it('validates and stores settings with an audit trail', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ...DEFAULT_SETTINGS, thresholdKw: -1 },
    });
    expect(bad.statusCode).toBe(400);
    const next = { ...DEFAULT_SETTINGS, thresholdKw: 11.5 };
    // AUTH_MODE=none: client-supplied identity headers are ignored
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: next,
      headers: { 'remote-user': 'mallory' },
    });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject('/api/settings')).json<{ thresholdKw: number }>().thresholdKw).toBe(
      11.5,
    );
    const [audit] = await sql<
      { actor: string }[]
    >`SELECT actor FROM audit_log ORDER BY id DESC LIMIT 1`;
    expect(audit?.actor).toBe('local');
  });

  it('imports a billing-meter CSV, detects the alignment and reconciles', async () => {
    // Portal-style export: end-stamped local times, decimal commas, 2 % above our meter.
    const fmt = (ts: number) => {
      const p = new Intl.DateTimeFormat('de-AT', {
        timeZone: 'Europe/Vienna',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(ts);
      const g = (t: string) => p.find((x) => x.type === t)!.value;
      return `${g('day')}.${g('month')}.${g('year')} ${g('hour')}:${g('minute')}`;
    };
    const lines = ['Messzeitpunkt;Gemessener Verbrauch (kWh)'];
    for (let t = JAN; t < JAN + 2 * 86_400_000; t += INTERVAL_MS) {
      const kw = 2 + ((t / INTERVAL_MS) % 5); // varied so the alignment is detectable
      lines.push(
        `${fmt(t + INTERVAL_MS)};${String(((kw * 250 * 1.02) / 1000).toFixed(4)).replace('.', ',')}`,
      );
    }
    // own data with the same pattern for those two days
    const mine: ClosedInterval[] = [];
    for (let t = JAN; t < JAN + 2 * 86_400_000; t += INTERVAL_MS)
      mine.push(iv(t, 2 + ((t / INTERVAL_MS) % 5)));
    await upsertIntervals(db, mine);

    const res = await app.inject({
      method: 'POST',
      url: '/api/reconciliation/import?filename=netz-noe.csv',
      headers: { 'content-type': 'text/csv' },
      payload: lines.join('\r\n'),
    });
    expect(res.statusCode).toBe(200);
    const imp = res.json<{ batchId: number; rows: number; alignment: string; from: number }>();
    expect(imp).toMatchObject({ rows: 192, alignment: 'end', from: JAN });

    const rec = (
      await app.inject(`/api/reconciliation?from=${JAN}&to=${JAN + 2 * 86_400_000}`)
    ).json<{
      n: number;
      suggestedFactor: number;
      months: { officialPeakKw: number }[];
    }>();
    expect(rec.n).toBe(192);
    expect(rec.suggestedFactor).toBeCloseTo(1.02, 3);

    const month = (await app.inject('/api/months/2027-01')).json<{
      official: { peak: { kw: number }; intervalCount: number };
    }>();
    expect(month.official.intervalCount).toBe(192);
    expect(month.official.peak.kw).toBeCloseTo(6 * 1.02, 3);

    expect(
      (await app.inject({ method: 'DELETE', url: `/api/reconciliation/batches/${imp.batchId}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/reconciliation/batches/${imp.batchId}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject('/api/months/2027-01')).json<{ official: unknown }>().official,
    ).toBeNull();
  });

  it('rejects CSV files it cannot understand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/reconciliation/import',
      headers: { 'content-type': 'text/csv' },
      payload: 'foo;bar\n1;2\n',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/header/);
  });

  describe('authentication', () => {
    const appWith = (extra: Record<string, string>) =>
      buildApp({
        env: apiEnvSchema.parse({
          DATABASE_URL: 'postgres://unused',
          LOG_LEVEL: 'error',
          ...extra,
        }),
        db,
        sql,
        hub: new LiveHub(),
      });

    it('password mode: protects the API and issues a session cookie', async () => {
      const a = await appWith({
        AUTH_MODE: 'password',
        AUTH_USERNAME: 'tobias',
        AUTH_PASSWORD: 'correct horse battery',
        AUTH_SECRET: 'x'.repeat(32),
      });
      try {
        expect((await a.inject('/api/health')).statusCode).toBe(200);
        expect((await a.inject('/api/settings')).statusCode).toBe(401);
        expect((await a.inject('/api/auth/me')).json()).toEqual({ mode: 'password', user: null });

        const bad = await a.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'tobias', password: 'nope' },
        });
        expect(bad.statusCode).toBe(401);

        const ok = await a.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'tobias', password: 'correct horse battery' },
          headers: { 'x-forwarded-proto': 'https' },
        });
        expect(ok.statusCode).toBe(200);
        const cookie = String(ok.headers['set-cookie']);
        expect(cookie).toMatch(
          /^pg_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
        );
        const session = cookie.split(';')[0]!;

        const me = await a.inject({ url: '/api/auth/me', headers: { cookie: session } });
        expect(me.json()).toEqual({ mode: 'password', user: 'tobias' });
        expect(
          (await a.inject({ url: '/api/settings', headers: { cookie: session } })).statusCode,
        ).toBe(200);

        // audit trail records the logged-in user
        await a.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: { cookie: session },
          payload: { ...DEFAULT_SETTINGS, thresholdKw: 12 },
        });
        const [audit] = await sql<
          { actor: string }[]
        >`SELECT actor FROM audit_log ORDER BY id DESC LIMIT 1`;
        expect(audit?.actor).toBe('tobias');

        // brute force is rate limited: 5 failed attempts per minute per IP (the earlier
        // failure was cleared by the successful login)
        const codes: number[] = [];
        for (let i = 0; i < 7; i++) {
          codes.push(
            (
              await a.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: { username: 'x', password: 'y' },
              })
            ).statusCode,
          );
        }
        expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
        // even the right password is refused while blocked
        const blocked = await a.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'tobias', password: 'correct horse battery' },
        });
        expect(blocked.statusCode).toBe(429);
      } finally {
        await a.close();
      }
    });

    it('proxy mode: trusts the configured header', async () => {
      const a = await appWith({ AUTH_MODE: 'proxy', AUTH_PROXY_HEADER: 'X-Forwarded-User' });
      try {
        expect((await a.inject('/api/settings')).statusCode).toBe(401);
        const r = await a.inject({ url: '/api/auth/me', headers: { 'x-forwarded-user': 'alice' } });
        expect(r.json()).toEqual({ mode: 'proxy', user: 'alice' });
        expect(
          (await a.inject({ url: '/api/settings', headers: { 'x-forwarded-user': 'alice' } }))
            .statusCode,
        ).toBe(200);
      } finally {
        await a.close();
      }
    });

    it('metrics token bypasses the session', async () => {
      const a = await appWith({
        AUTH_MODE: 'password',
        AUTH_PASSWORD: 'correct horse battery',
        METRICS_TOKEN: 't'.repeat(20),
      });
      try {
        const r = await a.inject({
          url: '/api/metrics',
          headers: { authorization: `Bearer ${'t'.repeat(20)}` },
        });
        expect(r.statusCode).not.toBe(401);
        expect((await a.inject('/api/metrics')).statusCode).toBe(401);
      } finally {
        await a.close();
      }
    });
  });

  it('exposes Prometheus metrics including the live snapshot', async () => {
    const hub = new LiveHub();
    const a = await buildApp({
      env: apiEnvSchema.parse({ DATABASE_URL: 'postgres://unused' }),
      db,
      sql,
      hub,
    });
    try {
      hub.receive(
        JSON.stringify({
          ts: Date.now(),
          connection: 'ok',
          power: { gridW: 4200, loadW: 5000, pvW: 800, batteryW: 0, socPct: 55 },
          interval: {
            start: 0,
            end: 900_000,
            elapsedMs: 1,
            remainingMs: 1,
            importWh: 1,
            runningAvgKw: 1,
            committedKw: 2.5,
            projectedKw: 9.5,
            completeness: 1,
            source: 'counter',
          },
          thresholdKw: 10,
          effectiveLimitKw: 10,
          monthPeak: { start: 0, kw: 12.4 },
          state: 'warning',
          monthCostEur: 23.4,
          projectedExtraCostEur: 0,
        }),
      );
      await a.inject('/api/settings');
      const res = await a.inject('/api/metrics');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.body).toMatch(/^peakguard_grid_power_watts 4200$/m);
      expect(res.body).toMatch(/^peakguard_interval_projected_kw 9.5$/m);
      expect(res.body).toMatch(/^peakguard_interval_state 1$/m);
      expect(res.body).toMatch(/^peakguard_month_peak_kw 12.4$/m);
      expect(res.body).toMatch(
        /peakguard_api_http_request_duration_seconds_count\{method="GET",route="\/api\/settings",status="200"\} 1/,
      );
      expect(res.body).toMatch(/^peakguard_api_process_cpu_user_seconds_total /m);
    } finally {
      await a.close();
    }
  });

  it('validates simulation requests', async () => {
    const body = {
      from: PEAK,
      to: PEAK + 86_400_000,
      battery: { capacityKwh: 10, maxPowerKw: 6 },
      control: { thresholdKw: 10, reservePct: 40 },
    };
    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/simulation',
      payload: {
        ...body,
        sweep: {
          thresholdsKw: [10, 11, 12, 13, 14],
          reservesPct: [10, 20, 30, 40, 50, 60, 70],
          capacitiesKwh: [5, 10],
        },
      },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json<{ error: string }>().error).toMatch(/too large/);
    // only 15 minutes of samples in this database
    const thin = await app.inject({ method: 'POST', url: '/api/simulation', payload: body });
    expect(thin.statusCode).toBe(400);
    expect(thin.json<{ error: string }>().error).toMatch(/not enough data/);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/simulation',
          payload: { ...body, to: body.from },
        })
      ).statusCode,
    ).toBe(400);
  });

  describe('control', () => {
    const status = (patch: Record<string, unknown> = {}) => ({
      ts: Date.now(),
      mode: 'dryRun',
      writesEnabled: true,
      modbus: { state: 'ok', error: null, storage: null, model: null },
      decision: null,
      command: null,
      note: null,
      revertTest: null,
      ...patch,
    });
    const active = { ...DEFAULT_SETTINGS.control, mode: 'active' };

    it('gates Active on both the control and the settings endpoint', async () => {
      await kvSet(db, 'control.status', status());
      const r = await app.inject({ method: 'PUT', url: '/api/control', payload: active });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toMatch(/revert self-test/);
      const viaSettings = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { ...DEFAULT_SETTINGS, control: active },
      });
      expect(viaSettings.statusCode).toBe(409);

      await kvSet(
        db,
        'control.status',
        status({ revertTest: { status: 'passed', startedAt: 0, finishedAt: 1, message: 'ok' } }),
      );
      expect(
        (await app.inject({ method: 'PUT', url: '/api/control', payload: active })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject('/api/control/status')).json<{ settings: { mode: string } }>().settings
          .mode,
      ).toBe('active');
      // back to dry-run is always allowed
      await kvSet(db, 'control.status', status({ writesEnabled: false }));
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/control',
            payload: { ...active, mode: 'dryRun' },
          })
        ).statusCode,
      ).toBe(200);
    });

    it('sends the revert-test command to the collector only when possible', async () => {
      await kvSet(db, 'control.status', status({ writesEnabled: false }));
      const blocked = await app.inject({ method: 'POST', url: '/api/control/revert-test' });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json<{ error: string }>().error).toMatch(/CONTROL_WRITES_ENABLED/);

      await kvSet(db, 'control.status', status());
      const received: string[] = [];
      const listener = await sql.listen('control_command', (p) => received.push(p));
      const ok = await app.inject({ method: 'POST', url: '/api/control/revert-test' });
      expect(ok.statusCode).toBe(202);
      await expect.poll(() => received.length).toBe(1);
      expect(JSON.parse(received[0]!)).toMatchObject({ type: 'revertTest', revertS: 60 });
      await listener.unlisten();
    });
  });
});
