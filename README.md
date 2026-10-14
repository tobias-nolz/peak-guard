# Peak Guard

Self-hosted monitoring of 15-minute grid peaks for a Fronius Gen24 + Smart Meter + battery system. Battery-based peak shaving comes in phase 2.

From 2027, Austrian grid operators (here: Netz NÖ) bill a **capacity charge (Leistungspreis)** on the highest 15-minute average grid import of each month. One bad quarter-hour sets the price for the whole month. Peak Guard measures every clock-aligned quarter-hour the way the billing meter does and shows the current interval's projection live. It also tells you what the month's peak costs.

> **Status:** Phase 1 in progress (milestones M0–M3 done: data pipeline, live UI, settings).
> History analytics, reconciliation and peak-shaving control follow. See [Roadmap](#roadmap).

## Quickstart (with the built-in mock inverter)

Requirements: Docker with Compose v2.

```sh
cp .env.example .env              # set POSTGRES_PASSWORD
docker compose --profile dev up -d --build
open http://localhost:8080        # API docs: http://localhost:8080/api/docs
```

The `dev` profile starts a simulated Gen24 household: base load, cooking, EV charging, a heat pump, 10 kWp PV and a BYD 10.24 kWh battery. To watch quarter-hours close quickly, run the simulation 30× faster:

```sh
# .env
MOCK_SPEED=30
CLOCK_SOURCE=inverter
POLL_INTERVAL_MS=100
```

## Using your real inverter

1. In the Gen24 web UI, enable **Communication → Solar API** (the local HTTP/JSON API, read only).
2. Set `FRONIUS_URL=http://<inverter-ip>` in `.env` and leave `CLOCK_SOURCE=local`.
3. `docker compose up -d` (without the `dev` profile).

Phase 1 only _reads_ data. Nothing is ever written to the inverter. Hardware details and the research behind the phase 2 control path are in [docs/hardware.md](docs/hardware.md).

## How peaks are measured

- **Quarter-hours** are clock-aligned (:00/:15/:30/:45) in `Europe/Vienna`. Vienna's UTC offset is a whole number of hours, so DST never shifts a quarter-hour. It only changes how many a day has (92 or 100).
- **Interval energy** comes from the Smart Meter's cumulative import counter. Its value is linearly interpolated at each boundary between the surrounding samples. Power integration is only a fallback, used when no counter is available.
- **Peak** = import energy of the interval ÷ 0.25 h, in kW. The month's maximum is billed, but at least the _minimum billed power_ (10 kW by default).
- **Quality per interval:**

  | Quality     | Meaning                                                    |
  | ----------- | ---------------------------------------------------------- |
  | `exact`     | Both boundary counters are interpolated from close samples |
  | `estimated` | Energy derived across a data gap from the counters         |
  | `partial`   | First interval after a fresh start, extrapolated           |
  | `missing`   | Gap longer than `MAX_BACKFILL_HOURS`                       |

  Gaps inside an interval don't affect accuracy: the counter difference is still exact, and only the coverage indicator drops.

- **Projection** for the running interval = energy so far + smoothed current import × remaining time.
- A **calibration factor** (Settings) scales your own measurement to match the official billing meter.

## Architecture

```
Fronius Gen24 ──HTTP (Solar API v1)──▶ collector ──▶ TimescaleDB ◀── api (Fastify) ◀── web (Caddy + React SPA)
                                           │   NOTIFY "live"   ▲            │ SSE
                                           └───────────────────┘            └────▶ browser
```

| Service         | Role                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collector`     | Polls the inverter (1–5 s), turns samples into quarter-hours, persists everything and publishes live snapshots via Postgres `NOTIFY`. It runs on its own, so monitoring (and later control) continues when the UI is down. |
| `api`           | REST + OpenAPI (`/api/docs`). Streams live snapshots to browsers via Server-Sent Events. Settings changes notify the collector.                                                                                            |
| `web`           | React SPA served by Caddy, which also proxies `/api`. PWA-installable, dark mode, German/English.                                                                                                                          |
| `db`            | PostgreSQL 18 + TimescaleDB. Raw samples (hypertable, compressed after 2 days, kept 90 days), a 1-minute continuous aggregate (2 years) and the quarter-hour table (forever).                                              |
| `mock-inverter` | `dev` profile only. Speaks Solar API v1 like a Gen24, with time acceleration and fault injection.                                                                                                                          |

Monorepo layout (pnpm workspaces, TypeScript strict):

| Path               | Contents                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| `packages/core`    | Pure logic: quarter-hour tracker, time zones/DST, tariff and € maths, peak helpers |
| `packages/shared`  | Zod schemas: settings, live snapshot                                               |
| `packages/db`      | Drizzle schema, migrations, TimescaleDB setup, queries                             |
| `packages/fronius` | Solar API client and response mapping (Modbus/SunSpec follows in M7)               |
| `packages/sim`     | Deterministic household simulator (used by the mock and the tests)                 |
| `apps/*`           | `collector`, `api`, `web`, `mock-inverter`                                         |

Design decisions that deviate from the original brief:

- **Quarter-hours are computed in the collector, not in a continuous aggregate.** Billing needs counter values interpolated _at_ the boundaries, which spans buckets. The continuous aggregate serves chart downsampling.
- **TimescaleDB objects live outside the Drizzle migrations.** Continuous aggregates can't be created inside a transaction, so they are set up idempotently right after the migrations (`packages/db/src/timescale.ts`).
- **TypeScript 6.0 instead of 7.0.** typescript-eslint (type-aware linting) doesn't support 7.x yet.
- **Node 24 LTS instead of 26.** Node 26 becomes LTS at the end of October 2026.

## Configuration

All deployment settings are in `.env` (see [.env.example](.env.example), which documents every variable). Settings that can change at runtime are edited in the UI and stored in the database:

- threshold
- warning level
- calibration factor
- projection smoothing
- tariff

Every change is written to an audit log.

Tariff defaults are **placeholders** until Netz NÖ publishes the 2027 price sheet: 19 €/kW/year up to 10 kW and 38 €/kW/year above (assumed 2× the base price), minimum 10 kW. Edit them under Settings.

## Development

```sh
corepack enable                          # pnpm 10 via packageManager
pnpm install
docker compose up -d db                  # TimescaleDB on 127.0.0.1:5432

# three terminals (or use the compose dev profile instead)
PORT=8090 MOCK_SPEED=30 pnpm --filter @peak-guard/mock-inverter dev
DATABASE_URL=postgres://peakguard:<pw>@127.0.0.1:5432/peakguard FRONIUS_URL=http://127.0.0.1:8090 \
  CLOCK_SOURCE=inverter POLL_INTERVAL_MS=100 HEALTH_PORT=8181 LOG_PRETTY=true pnpm --filter @peak-guard/collector dev
DATABASE_URL=postgres://peakguard:<pw>@127.0.0.1:5432/peakguard PORT=3001 pnpm --filter @peak-guard/api dev
pnpm --filter @peak-guard/web dev        # http://localhost:5173, proxies /api to :3001
```

Quality gates (all run in CI):

```sh
pnpm format:check && pnpm lint && pnpm typecheck
TEST_DATABASE_URL=postgres://peakguard:<pw>@127.0.0.1:5432/peakguard pnpm test   # unit + DB integration
pnpm --filter @peak-guard/web e2e        # Playwright against http://localhost:8080 (compose dev stack)
```

Internal packages export their TypeScript sources under the custom condition `@peak-guard/source`. Development tooling (tsx, Vite, Vitest, `tsc --noEmit`) uses it, so there is no build step during development. Production builds compile each package to `dist/`, and `pnpm deploy` produces a slim image per service.

## Troubleshooting

| Symptom                                   | Check                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Badge shows "Inverter offline"            | Can the host reach `FRONIUS_URL`? Is the Solar API enabled? `docker compose logs collector`  |
| Intervals marked `estimated`              | A data gap occurred (see events / collector logs). The energy comes from the meter counters. |
| Log warning "inverter repeats timestamps" | `CLOCK_SOURCE=inverter` is only for the accelerated mock. Use `local` with a real inverter.  |
| No live updates, but the page loads       | A reverse proxy in front of Caddy must not buffer `text/event-stream`                        |
| `db` won't start after an upgrade         | The PostgreSQL major version changed. Restore from a dump (backup tooling arrives in M5).    |

## Roadmap

| Milestone | Scope                                                                                               | Status |
| --------- | --------------------------------------------------------------------------------------------------- | ------ |
| M0–M3     | Scaffold, mock inverter, collector + interval maths, API, live UI, settings, CI                     | ✅     |
| M4        | History: ranges, monthly view, top-N with likely cause, heatmap, histogram, duration curve, exports | next   |
| M5        | Netz NÖ CSV import + calibration, auth, audit view, backups, metrics, docs                          |        |
| M6        | What-if simulation of thresholds / reserves / battery sizes                                         |        |
| M7        | Modbus/SunSpec readout, dry-run controller, hardware checklist, revert self-test                    |        |
| M8        | Active peak shaving (gated, fail-benign setpoints only)                                             |        |
| M9        | Notifications, MQTT + Home Assistant, load-shedding hooks, time-variable grid fees                  |        |
