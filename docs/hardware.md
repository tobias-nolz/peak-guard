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

## Open questions for your installation

- Inverter IP and Gen24 firmware version
- BYD model (HVS/HVM) and usable kWh
- Smart Meter model and position (feed-in point assumed)
- Wallbox / heat pump model and API, for load-shedding hooks
- A sample CSV export from the Netz NÖ smart-meter portal, for reconciliation (M5)
