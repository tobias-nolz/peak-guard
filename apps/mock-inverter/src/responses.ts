import type { HouseState } from '@peak-guard/sim';

/** Solar API v1 response builders mimicking a Fronius Gen24 with Smart Meter TS 65A-3. */

const head = (ts: number, args: Record<string, string> = {}) => ({
  RequestArguments: args,
  Status: { Code: 0, Reason: '', UserMessage: '' },
  // Real devices report whole seconds; the mock keeps ms so accelerated time stays precise.
  Timestamp: new Date(ts).toISOString(),
});

const r1 = (n: number) => Math.round(n * 10) / 10;

export function powerFlow(s: HouseState) {
  return {
    Body: {
      Data: {
        Inverters: {
          '1': {
            Battery_Mode: s.batteryW === 0 ? 'standby' : 'normal',
            DT: 1,
            E_Day: null,
            E_Total: null,
            E_Year: null,
            P: r1(s.pvW + s.batteryW),
            SOC: r1(s.socPct),
          },
        },
        SecondaryMeters: {},
        Site: {
          BackupMode: false,
          BatteryStandby: s.batteryW === 0,
          E_Day: null,
          E_Total: null,
          E_Year: null,
          Meter_Location: 'grid',
          Mode: 'bidirectional',
          P_Akku: r1(s.batteryW),
          P_Grid: r1(s.gridW),
          P_Load: r1(-s.loadW),
          P_PV: r1(s.pvW),
          rel_Autonomy:
            s.loadW > 0
              ? r1(Math.min(100, Math.max(0, (1 - Math.max(0, s.gridW) / s.loadW) * 100)))
              : 100,
          rel_SelfConsumption: 100,
        },
        Smartloads: { OhmpilotEcos: {}, Ohmpilots: {} },
        Version: '13',
      },
    },
    Head: head(s.ts),
  };
}

export function meterSystem(s: HouseState) {
  const phase = s.gridW / 3;
  return {
    Body: {
      Data: {
        '0': {
          Current_AC_Phase_1: r1(phase / 230),
          Current_AC_Phase_2: r1(phase / 230),
          Current_AC_Phase_3: r1(phase / 230),
          Details: { Manufacturer: 'Fronius', Model: 'Smart Meter TS 65A-3', Serial: 'MOCK0001' },
          Enable: 1,
          EnergyReal_WAC_Minus_Absolute: Math.round(s.exportWh),
          EnergyReal_WAC_Plus_Absolute: Math.round(s.importWh),
          EnergyReal_WAC_Sum_Consumed: Math.round(s.importWh),
          EnergyReal_WAC_Sum_Produced: Math.round(s.exportWh),
          Frequency_Phase_Average: 50,
          Meter_Location_Current: 0,
          PowerReal_P_Phase_1: r1(phase),
          PowerReal_P_Phase_2: r1(phase),
          PowerReal_P_Phase_3: r1(phase),
          PowerReal_P_Sum: r1(s.gridW),
          SMARTMETER_ENERGYACTIVE_CONSUMED_SUM_F64: Math.round(s.importWh),
          SMARTMETER_ENERGYACTIVE_PRODUCED_SUM_F64: Math.round(s.exportWh),
          TimeStamp: Math.floor(s.ts / 1000),
          Visible: 1,
        },
      },
    },
    Head: head(s.ts, { Scope: 'System' }),
  };
}

export function storageSystem(s: HouseState, capacityWh: number) {
  return {
    Body: {
      Data: {
        '0': {
          Controller: {
            Capacity_Maximum: capacityWh,
            DesignedCapacity: capacityWh,
            Details: {
              Manufacturer: 'BYD',
              Model: 'BYD Battery-Box Premium HV',
              Serial: 'MOCKBYD01',
            },
            Enable: 1,
            StateOfCharge_Relative: r1(s.socPct),
            Status_BatteryCell: 3,
            Temperature_Cell: 21.5,
            TimeStamp: Math.floor(s.ts / 1000),
            Voltage_DC: 409.6,
          },
          Modules: [],
        },
      },
    },
    Head: head(s.ts, { Scope: 'System' }),
  };
}
