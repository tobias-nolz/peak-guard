import type { ModbusTransport } from './transport.js';

/** In-memory register map implementing ModbusTransport (tests, simulations). */
export class MemoryTransport implements ModbusTransport {
  readonly writes: [number, number][] = [];
  /** Called after each register write (e.g. to emulate inverter behaviour). */
  onWrite?: (address: number, value: number) => void;
  /** Make the next calls fail (communication loss). */
  failing = false;

  constructor(readonly regs = new Map<number, number>()) {}

  read(address: number, length: number): Promise<number[]> {
    if (this.failing) return Promise.reject(new Error('timeout (simulated)'));
    return Promise.resolve(Array.from({ length }, (_, i) => this.regs.get(address + i) ?? 0));
  }

  write(address: number, values: number[]): Promise<void> {
    if (this.failing) return Promise.reject(new Error('timeout (simulated)'));
    values.forEach((v, i) => {
      this.regs.set(address + i, v);
      this.writes.push([address + i, v]);
      this.onWrite?.(address + i, v);
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A Gen24-like SunSpec register image (int+SF) with model 124 at 40343, for tests:
 * WChaMax 6000 W, SoC 30 %, InOutWRte_SF −2, limits at 100 %, StorCtl_Mod 0.
 */
export function sunspecTestImage(
  opts: { wChaMaxW?: number; socPct?: number } = {},
): Map<number, number> {
  const regs = new Map<number, number>([
    [40000, 0x5375],
    [40001, 0x6e53],
  ]);
  let addr = 40002;
  for (const [id, len] of [
    [1, 65],
    [103, 50],
    [120, 26],
    [121, 30],
    [122, 44],
    [123, 24],
    [160, 88],
  ] as const) {
    regs.set(addr, id);
    regs.set(addr + 1, len);
    addr += 2 + len;
  }
  regs.set(addr, 124);
  regs.set(addr + 1, 24);
  const d = addr + 2;
  const vals = [
    opts.wChaMaxW ?? 6_000,
    100,
    100,
    0,
    0xffff,
    500,
    Math.round((opts.socPct ?? 30) * 10),
    0xffff,
    4096,
    6,
    10_000,
    10_000,
    0,
    0,
    0,
    1,
    0,
    0x8000,
    0x8000,
    0xfffe,
    0xffff,
    0x8000,
    0xffff,
    0xfffe,
  ];
  vals.forEach((v, i) => regs.set(d + i, v));
  regs.set(d + 24, 0xffff);
  regs.set(d + 25, 0);
  return regs;
}
