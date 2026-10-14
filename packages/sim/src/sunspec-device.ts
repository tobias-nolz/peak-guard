import type { House } from './house.js';

/**
 * A simulated Gen24 SunSpec register map (int+SF) backed by a House: model 124 reads the
 * live battery state and writes go to the simulated battery control (including the revert
 * timer, in simulated time). Used by the mock inverter's Modbus server and by controller
 * integration tests (through DeviceTransport).
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
const MODEL_AT = new Map<number, number>();
let END_AT = BASE + 2;
for (const [id, len] of CHAIN) {
  MODEL_AT.set(id, END_AT);
  END_AT += 2 + len;
}
const M124 = MODEL_AT.get(124)! + 2;

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

export class ModbusException extends Error {
  constructor(
    message: string,
    readonly modbusErrorCode: number,
  ) {
    super(message);
  }
}

export interface SunSpecDeviceOptions {
  /** "Inverter control via Modbus" switch; false makes writes fail. */
  controlEnabled: boolean;
}

export class SunSpecDevice {
  private readonly common = [...ascii('Fronius', 16), ...ascii('Primo GEN24 Mock', 16)];

  constructor(
    readonly house: House,
    private readonly now: () => number,
    readonly opts: SunSpecDeviceOptions,
  ) {}

  read(addr: number): number {
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
    if (addr >= c && addr < c + this.common.length) return this.common[addr - c]!;
    if (addr >= M124 && addr < M124 + 24) {
      const s = this.house.advanceTo(this.now());
      const ctl = this.house.control;
      switch (addr - M124) {
        case OFF.WChaMax:
          return u16(this.house.config.batteryMaxW);
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
  }

  write(addr: number, value: number): void {
    if (!this.opts.controlEnabled)
      throw new ModbusException('inverter control via Modbus is disabled', 0x01);
    const now = this.now();
    this.house.advanceTo(now);
    switch (addr - M124) {
      case OFF.StorCtl_Mod:
        return this.house.writeControl({ storCtlMod: value & 0x3 }, now);
      case OFF.OutWRte:
        return this.house.writeControl({ outWRtePct: s16(value) / 100 }, now);
      case OFF.InWRte:
        return this.house.writeControl({ inWRtePct: s16(value) / 100 }, now);
      case OFF.RvrtTms:
        return this.house.writeControl({ revertS: value }, now);
      case OFF.MinRsvPct:
        return this.house.writeControl({ minReservePct: value / 100 }, now);
      default:
        // WinTms/RmpTms accepted but not simulated; read-only registers are ignored (as on Fronius).
        return;
    }
  }
}

/**
 * Structural ModbusTransport (read/write/close) over a SunSpecDevice, without a network.
 * `failing` simulates a communication loss.
 */
export class DeviceTransport {
  failing = false;
  readonly writes: [number, number][] = [];
  constructor(readonly device: SunSpecDevice) {}

  read(address: number, length: number): Promise<number[]> {
    if (this.failing) return Promise.reject(new Error('timeout (simulated)'));
    return Promise.resolve(Array.from({ length }, (_, i) => this.device.read(address + i)));
  }

  write(address: number, values: number[]): Promise<void> {
    if (this.failing) return Promise.reject(new Error('timeout (simulated)'));
    try {
      values.forEach((v, i) => {
        this.device.write(address + i, v);
        this.writes.push([address + i, v]);
      });
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
