import { createRequire } from 'node:module';
import type { House } from '@peak-guard/sim';
import type { SimClock } from './server.js';

const { ServerTCP } = createRequire(import.meta.url)(
  'modbus-serial',
) as typeof import('modbus-serial');

/**
 * Modbus TCP server emulating a Gen24's SunSpec map (int+SF). Model 124 is live: it reads
 * from and writes to the simulated battery control, including the revert timer (in
 * simulated time). With `controlEnabled = false` writes fail like on an inverter where
 * "Inverter control via Modbus" is switched off.
 */

const BASE = 40_000;
// Chain like a Gen24 with int+SF data type: 1, 103, 120, 121, 122, 123, 160 (4 modules), 124.
const CHAIN: [number, number][] = [
  [1, 65],
  [103, 50],
  [120, 26],
  [121, 30],
  [122, 44],
  [123, 24],
  [160, 88],
  [124, 24],
];

function layout() {
  const at = new Map<number, number>();
  let addr = BASE + 2;
  for (const [id, len] of CHAIN) {
    at.set(id, addr);
    addr += 2 + len;
  }
  return { at, end: addr };
}

const { at: MODEL_AT, end: END_AT } = layout();
const M124 = MODEL_AT.get(124)! + 2; // first data register of model 124

const OFF = {
  WChaMax: 0,
  StorCtl_Mod: 3,
  MinRsvPct: 5,
  ChaState: 6,
  InBatV: 8,
  ChaSt: 9,
  OutWRte: 10,
  InWRte: 11,
  WinTms: 12,
  RvrtTms: 13,
  RmpTms: 14,
  ChaGriSet: 15,
  WChaMax_SF: 16,
  MinRsvPct_SF: 19,
  ChaState_SF: 20,
  InBatV_SF: 22,
  InOutWRte_SF: 23,
} as const;

const u16 = (v: number) => Math.round(v) & 0xffff;
const s16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);

function ascii(text: string, regs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < regs; i++)
    out.push(((text.charCodeAt(2 * i) || 0) << 8) | (text.charCodeAt(2 * i + 1) || 0));
  return out;
}

export interface MockModbusOptions {
  port: number;
  host?: string;
  controlEnabled: boolean;
}

export function createModbusServer(house: House, clock: SimClock, opts: MockModbusOptions) {
  const common = [...ascii('Fronius', 16), ...ascii('Primo GEN24 Mock', 16)];

  const read = (addr: number): number => {
    if (addr === BASE) return 0x5375;
    if (addr === BASE + 1) return 0x6e53;
    for (const [id, len] of CHAIN) {
      const a = MODEL_AT.get(id)!;
      if (addr === a) return id;
      if (addr === a + 1) return len;
    }
    if (addr === END_AT) return 0xffff;
    if (addr === END_AT + 1) return 0;
    const c = MODEL_AT.get(1)! + 2;
    if (addr >= c && addr < c + common.length) return common[addr - c]!;
    if (addr >= M124 && addr < M124 + 24) {
      const s = house.advanceTo(clock.now());
      const ctl = house.control;
      const cfg = house.config;
      switch (addr - M124) {
        case OFF.WChaMax:
          return u16(cfg.batteryMaxW);
        case OFF.StorCtl_Mod:
          return ctl.storCtlMod;
        case OFF.MinRsvPct:
          return u16(ctl.minReservePct * 100);
        case OFF.ChaState:
          return u16(s.socPct * 10);
        case OFF.InBatV:
          return 4096;
        case OFF.ChaSt:
          return s.batteryW > 10 ? 3 : s.batteryW < -10 ? 4 : 6; // DISCHARGING / CHARGING / HOLDING
        case OFF.OutWRte:
          return u16(ctl.outWRtePct * 100);
        case OFF.InWRte:
          return u16(ctl.inWRtePct * 100);
        case OFF.RvrtTms:
          return ctl.revertS;
        case OFF.ChaGriSet:
          return 1;
        case OFF.MinRsvPct_SF:
        case OFF.InOutWRte_SF:
          return 0xfffe; // -2
        case OFF.ChaState_SF:
        case OFF.InBatV_SF:
          return 0xffff; // -1
        case OFF.WChaMax_SF:
          return 0;
        default:
          return addr - M124 >= 16 ? 0x8000 : 0xffff; // not implemented
      }
    }
    return 0;
  };

  const write = (addr: number, value: number) => {
    if (!opts.controlEnabled) {
      throw Object.assign(new Error('inverter control via Modbus is disabled'), {
        modbusErrorCode: 0x01,
      });
    }
    const now = clock.now();
    house.advanceTo(now);
    switch (addr - M124) {
      case OFF.StorCtl_Mod:
        return house.writeControl({ storCtlMod: value & 0x3 }, now);
      case OFF.OutWRte:
        return house.writeControl({ outWRtePct: s16(value) / 100 }, now);
      case OFF.InWRte:
        return house.writeControl({ inWRtePct: s16(value) / 100 }, now);
      case OFF.RvrtTms:
        return house.writeControl({ revertS: value }, now);
      case OFF.MinRsvPct:
        return house.writeControl({ minReservePct: value / 100 }, now);
      case OFF.WinTms:
      case OFF.RmpTms:
        return; // accepted, not simulated
      default:
        // Writes to read-only registers are ignored by Fronius.
        return;
    }
  };

  const server = new ServerTCP(
    { getHoldingRegister: read, setRegister: write },
    { host: opts.host ?? '0.0.0.0', port: opts.port, unitID: 1 },
  );
  return server;
}
