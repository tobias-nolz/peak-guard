# Hardware notes: Fronius Gen24, Smart Meter, BYD battery

Research status as of October 2026. Everything marked **verify** must be confirmed on your inverter's firmware before phase 2 control is enabled.

## Read path (phase 1): Solar API v1

Enable it in the Gen24 web UI under _Communication → Solar API_. It is read only.

| Endpoint                                                | Used for                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`   | Grid power `PowerReal_P_Sum` (+ import / − export) and the cumulative counters `EnergyReal_WAC_Sum_Consumed` (import Wh) and `…_Produced` (export Wh). The meter with `Meter_Location_Current = 0` (feed-in point) is selected. **This is the source of truth for interval energy.** |
| `/solar_api/v1/GetPowerFlowRealtimeData.fcgi`           | House load (`P_Load`, negative = consumption), PV (`P_PV`), battery (`P_Akku`, + discharge / − charge) and SoC (`Inverters[].SOC`)                                                                                                                                                   |
| `/solar_api/v1/GetStorageRealtimeData.cgi?Scope=System` | Battery capacity and model. Reportedly available only on firmware ≥ 1.13 and sparse on Gen24 (**verify**). Not polled.                                                                                                                                                               |

Fronius recommends at most 2 parallel requests and timeouts of at least 1 s. The collector makes 2 requests per poll.

## Control path (phase 2): Modbus TCP, SunSpec model 124

Not used yet. These are the prerequisites for M7/M8.

- Enable in the web UI under _Communication → Modbus_:
  - **Modbus TCP server**: port 502 (or 1502)
  - **Inverter control via Modbus**: without this, writes to models 123/124 raise exceptions
  - SunSpec data type _int + SF_ or _float_: the register addresses differ between the two
- Unit ID of the inverter is 1, of the primary meter 200.
- Model 124 starts at 40343 (int + SF) or 40353 (float) per the Fronius manual. Peak Guard will **discover** the model chain from 40000 (`SunS`) and read the scale factors at runtime instead of hard-coding addresses. Fronius notes that scale factors may change with firmware updates.

Model 124 fields:

| Field                | Meaning                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `WChaMax`            | Base for the % values (larger of max charge/discharge)                                                         |
| `StorCtl_Mod`        | bit0 = charge limit active, bit1 = discharge limit active                                                      |
| `InWRte` / `OutWRte` | % of `WChaMax`. **Negative `OutWRte` forces charging**, negative `InWRte` forces discharging.                  |
| `MinRsvPct`          | Minimum reserve. Writability on Gen24 is unclear (**verify**).                                                 |
| `ChaGriSet`          | Grid charging. AND-linked with the UI setting. evcc stopped writing it because it broke the UI's charge rules. |
| `InOutWRte_RvrtTms`  | Revert timeout. See below.                                                                                     |

### Revert timer conflict (the key safety question)

- The Fronius documentation and a Home Assistant PR list the model 124 revert timer as **not supported** on Gen24.
- Users of firmware 1.40.9-1 (batpred, knackerbrot) report that it _does_ revert.
- The HA PR measured (on model 123) that **only writes restart the timer, reads do not**.
- evcc removed the register after Fronius attributed a fault to command timing.

Peak Guard's policy (agreed):

1. Only _benign_ setpoints: discharge **limits** (`StorCtl_Mod = 2`, `OutWRte ≥ 0`), never forced charge or discharge. A stuck setpoint can only _reduce_ battery use.
2. An app-side watchdog restores inverter defaults on start, on shutdown and on any error. Keep-alive writes go out before any revert timeout.
3. **Active mode is gated on a revert self-test**: write a harmless limit with `RvrtTms = 60`, stop writing, and confirm it reverts. If it doesn't, Active stays possible only after an explicit warning acknowledgement.

Sources:

- [Fronius Gen24 Modbus TCP & RTU manual](https://manuals.fronius.com/html/4204102649/en-US.html)
- [Home Assistant PR #181388](https://github.com/home-assistant/core/pull/181388)
- [evcc PR #18386](https://github.com/evcc-io/evcc/pull/18386)
- [batpred discussion #3439](https://github.com/springfall2008/batpred/discussions/3439)
- [knackerbrot/fronius-modbus-control](https://github.com/knackerbrot/fronius-modbus-control)

## Enabling battery control: checklist

Work through these steps in order. Each one can be undone, and nothing is written to the inverter before step 6.

1. **Solar API on, data looks right.** Live values match the Fronius app, and quarter-hours close as `exact`.
2. **Enable Modbus on the Gen24.** In the web UI (technician access may be required), go to _Communication → Modbus_:
   - Set the **Modbus TCP server** to _on_, port 502.
   - Set **SunSpec Model Type** to _int + SF_. Peak Guard discovers the layout either way.
   - Switch **Inverter control via Modbus** on.
   - Leave "Restrict control" off, unless you want to restrict control to Peak Guard's IP address. In that case, enter the address of the Docker host.
3. **Let Peak Guard read the battery.** In `.env`, set `MODBUS_ENABLED=true` and keep `CONTROL_WRITES_ENABLED=false`. Then run `docker compose up -d`. Control → Status should show _Modbus connected_, plus the battery's max power, SoC, limit mode 0 and discharge limit 100 %.
4. **Dry-run for a while (days to weeks).** Control → mode _Dry-run_ (the default). Check that the decision log looks sensible: _Holding the reserve_ when SoC ≤ reserve, _Shaving_ only when a quarter-hour would exceed the target. The dry-run estimate shows the expected saving.
5. **Choose threshold and reserve with the simulation** (Simulation page), using your own history.
6. **Allow writes.** Set `CONTROL_WRITES_ENABLED=true`, then `docker compose up -d collector`.
7. **Run the revert self-test** (Control page). It writes a discharge limit of 100 %, which has no effect on the battery, with a 60 s revert timeout. Then it only _reads_, to see whether the inverter returns to its own mode by itself.
   - **Passed:** if Peak Guard stops or loses the connection, the inverter drops the limits after the revert timeout.
   - **Failed:** the firmware ignores the storage revert timer. Peak Guard restored the defaults itself. You can still enable Active after acknowledging the warning, but then the app-side watchdog is the only safety net. Setpoints are benign by design (discharge limits only), so a stuck setpoint can only _reduce_ battery use, never force charging or discharging. A Fronius firmware update may change this, so re-run the test after updates.
8. **Switch to Active** (Control page). Watch the decision chart and the inverter's battery status for the first evenings.

**Rollback at any time:**

- Control → _Dry-run_ or _Off_. The collector restores the inverter defaults (`StorCtl_Mod = 0`).
- `CONTROL_WRITES_ENABLED=false`, then `docker compose up -d collector`.
- In the Gen24 web UI, switch _Inverter control via Modbus_ off. Some firmware versions also offer a button that resets the Modbus API controls.

## Open questions for your installation

- Inverter IP and Gen24 firmware version
- BYD model (HVS/HVM) and usable kWh
- Smart Meter model and position (feed-in point assumed)
- Wallbox / heat pump model and API, for load-shedding hooks
