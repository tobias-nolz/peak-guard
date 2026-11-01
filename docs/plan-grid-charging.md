# Plan: grid charging of the peak-shaving reserve (with cooldown)

Status: **not started in code**. This file is the hand-over for continuing locally.
Branch: `claude/modest-franklin-h7raum`. Delete this file once the feature is merged.

## Goal

When the reserve (SoC ≤ `control.reservePct`) is depleted and the grid has headroom,
charge the battery from the grid back up to the reserve, without ever creating a new
peak, and without flip-flopping (charge → discharge/shave → charge …). A **cooldown**
must pass after every charge session _and_ after every shave before a new charge
session may start.

## Design decisions (already settled)

- **Charge target = `reservePct`.** Never charge above the reserve, otherwise the
  inverter's self-consumption (`release` mode) would discharge grid energy again and
  start a loop. At SoC == reserve `decide()` returns `hold`, which blocks discharge,
  so the state is stable.
- **SoC hysteresis:** a session only _starts_ at SoC ≤ `reservePct − hysteresisPct`.
- **Cooldown:** no new session until `cooldownMinutes` have passed since the last
  session ended **and** since the last `shave` decision.
- **No flip-flop inside a session:** if headroom drops, the charge power goes down
  (to 0 W = same as `hold`), but the session **does not end**. A session ends only
  when: the target is reached, a shave is needed (peak threat → stop immediately),
  the time window ends, the feature is disabled, or safety gates fail.
- **Peak-safe power:**
  `ceilingW = min(affordableW, (targetKw − marginKw)·1000) − headroomKw·1000`
  `chargeW = clamp(ceilingW − max(0, gridW + batteryW), 0, min(maxPowerW, WChaMax))`
  If `chargeW < minPowerW`, use 0 (paused) or don't start. `affordableW` is the same
  as in `decide()` (`leftWh / remainingH`). The cap at `target − margin` keeps late-interval
  "free budget" from causing big power jumps.
- **Modbus:** forced charge = `StorCtl_Mod = 2`, **negative `OutWRte`** (% of WChaMax),
  `InWRte = 100`. Never write `ChaGriSet` (it broke the Gen24 UI rules for evcc); instead
  _read_ it and require `chaGriSet === 1` (GRID). Otherwise add a note like "grid charging
  not allowed by the inverter (enable battery charging from grid in the Gen24 UI)".
- **Extra safety gates for charging** (stricter than for discharge limits):
  - `gridCharge.enabled` (default **false**)
  - revert self-test **passed** (`acknowledgeNoRevert` is NOT enough)
  - `batteryW` must be known (otherwise the charge power feeds back into its own calculation)
  - charge commands are written with `rvrtTmsS = min(cfg.revertTimeoutS, 60)`
  - stopping a charge is always immediate (not rate-limited by `minUpdateIntervalS`)
- The shave demand in `decide()` should exclude our own charging:
  `demandW = max(0, gridW + batteryW, batteryW)` (same as the old formula except when
  importing while charging, where the old one counted the charge power as house load).

## Settings (`packages/shared/src/settings.ts`, `defaults.ts`)

Add to `controlSchema`:

```ts
gridCharge: z.object({
  enabled: z.boolean(), // default false
  hysteresisPct: z.number().min(1).max(50), // default 10
  maxPowerW: z.number().min(0).max(20000), // default 3000
  minPowerW: z.number().min(0).max(5000), // default 500
  headroomKw: z.number().min(0).max(10), // default 1
  cooldownMinutes: z.number().int().min(0).max(1440), // default 60
  from: hhmm,
  to: hhmm, // local window; from == to = all day; default 22:00–06:00
});
```

`packages/db/src/repo.ts` `getSettings()`: deep-merge
`gridCharge: { ...DEFAULT_SETTINGS.control.gridCharge, ...data.control?.gridCharge }`.

## Core (`packages/core/src/control.ts`), pure and tested

- `ControlMode` += `'charge'`. `ControlDecision` += `chargeW: number` (0 unless charging).
- New pure function plus a state object (persistable):
  ```ts
  interface GridChargeState { active: boolean; since: number|null; lastStopAt: number|null; lastShaveAt: number|null }
  applyGridCharge(base: ControlDecision, i: ControlInputs, cfg: ControlConfig,
                  gc: GridChargeConfig & { inWindow: boolean }, state, nowMs)
    → { decision, state, reason: string | null }   // reason = why it isn't charging (cooldown 12 min left, …)
  ```
  Order: base `shave` → stop session, set `lastShaveAt`; base `release` → stop;
  `hold`/`empty` → continue the session or check the start conditions.
- Helper `inLocalWindow(ts, from, to, tz)` using `localParts` from `time.ts` (handle windows across midnight).
- Tests in `control.test.ts`: starts only below the hysteresis; never exceeds `target − margin − headroom`;
  stops immediately on a shave; **no restart during the cooldown after a stop or a shave**;
  pauses at 0 W instead of ending when headroom is gone; stops at the reserve; window across midnight.

## Fronius (`packages/fronius/src/modbus/sunspec.ts`)

`encodeStorageCommand(cmd, state, { allowForcedCharge = false } = {})`: allow
`outWRtePct` in −100..0 only with that flag; `inWRtePct` stays 0..100. `writeStorage`
passes the option through. Update `StorageCommand` doc comments and `sunspec.test.ts`.

## Collector

- `apps/collector/src/control/mapping.ts`: `commandFor` → for `charge`:
  `{ storCtlMod: 2, outWRtePct: -pct(chargeW), inWRtePct: 100, rvrtTmsS: min(revertS, 60) }`.
  `significantChange`: a sign change of `outWRtePct` is always significant. Tests in `mapping.test.ts`.
- `controller.ts`:
  - keep `GridChargeState`, load/save it in kv `control.gridCharge` on transitions (so a restart doesn't reset the cooldown)
  - after `decide()`, call `applyGridCharge` only if the gates pass; otherwise put the reason in `note` (dry-run still logs `charge` decisions)
  - `apply()`: if `written` is a forced charge and the new command isn't → write immediately
  - `write()` / `restoreDefaults()`: pass `allowForcedCharge` when the command has a negative OutWRte
  - add `chargeW` and `gridCharge` state/reason to `snapshotPart()` and `publishStatus()`
- DB: new column `charge_w real` in `control_decisions` (`packages/db/src/schema.ts`), new migration
  `0003_…` via `pnpm --filter @peak-guard/db db:generate` (needs no DB). Log `chargeW` in decision rows.
- Live snapshot schema (`packages/shared/src/live.ts`): decision enum += `'charge'`, add `chargeW`.

## Simulator (`packages/sim`)

`house.ts` already handles forced charging (negative OutWRte). Add a config `gridChargeAllowed`
(default true). `sunspec-device.ts` should report `ChaGriSet` = 1/0 from it, and forced charging
without permission should only use PV surplus.

## API and web

- `apps/api/src/control.ts` `activeBlockedReason`: with mode active and `gridCharge.enabled`, require
  revert test `passed` (409 with a clear message). Test in `control.test.ts`.
- `apps/web/src/lib/api.ts`: `DecisionDto.decision` += `'charge'`, add `chargeW`.
- `apps/web/src/routes/control.tsx`: a "Grid charging" section in `ParamsCard` (checkbox + the
  numbers + from/to); show the charge power in `StatusCard` and as a negative series in
  `DecisionsChart`.
- `apps/web/src/locales/en.json` + `de.json`: `control.decisions.charge` ("Charging from grid" /
  "Laden aus dem Netz"), labels for the new fields, explanation text.
- Optional: `packages/core/src/simulate.ts` support for `gridCharge` (add `gridChargeKwh` per month)
  so the simulation shows whether it pays off.

## Docs

README "Battery control: safety" + `docs/hardware.md` policy: forced charging is now possible but
only as an opt-in with the stricter gates above. `.env.example` doesn't change (runtime settings only).

## Checks before pushing

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

DB tests need `TEST_DATABASE_URL` (TimescaleDB, see `.github/workflows/ci.yml`). Extend
`apps/collector/test/active-control.db.test.ts` with a scenario: reserve empty at night → charge
starts, a load spike → stops immediately and shaves, no restart until the cooldown is over.
