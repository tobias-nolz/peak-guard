import { createRequire } from 'node:module';

const { ServerTCP } = createRequire(import.meta.url)(
  'modbus-serial',
) as typeof import('modbus-serial');

/**
 * A Gen24-like SunSpec register image (int+SF): models 1, 103, 120, 121, 122, 123,
 * 160 (4 modules, L=88), 124 at 40343, end marker. Model 124 holds a 10 kW battery path
 * with WChaMax_SF=0, InOutWRte_SF=-2 (0.01 %), SoC 63.2 % (SF -1).
 */
export function gen24Image(): Map<number, number> {
  const regs = new Map<number, number>();
  regs.set(40000, 0x5375);
  regs.set(40001, 0x6e53);
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
  const d = addr + 2; // model 124 data
  regs.set(addr, 124);
  regs.set(addr + 1, 24);
  const m124 = [
    10_000, // WChaMax
    100, // WChaGra
    100, // WDisChaGra
    0, // StorCtl_Mod
    0xffff, // VAChaMax (n/a)
    500, // MinRsvPct 5.00 % (SF -2)
    632, // ChaState 63.2 % (SF -1)
    0xffff, // StorAval
    4096, // InBatV 409.6 (SF -1)
    4, // ChaSt CHARGING
    10_000, // OutWRte 100.00 %
    10_000, // InWRte 100.00 %
    0, // WinTms
    0, // RvrtTms
    0, // RmpTms
    1, // ChaGriSet GRID
    0, // WChaMax_SF
    0x8000, // WChaDisChaGra_SF (n/a)
    0x8000, // VAChaMax_SF (n/a)
    0xfffe, // MinRsvPct_SF -2
    0xffff, // ChaState_SF -1
    0x8000, // StorAval_SF
    0xffff, // InBatV_SF -1
    0xfffe, // InOutWRte_SF -2
  ];
  m124.forEach((v, i) => regs.set(d + i, v));
  regs.set(d + 24, 0xffff);
  regs.set(d + 25, 0);
  return regs;
}

/** A free TCP port (modbus-serial treats port 0 as "use 502"). */
export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as import('node:net').AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export async function startModbusServer(
  regs: Map<number, number>,
  writes: [number, number][] = [],
) {
  const port = await freePort();
  const server = new ServerTCP(
    {
      getHoldingRegister: (addr: number) => regs.get(addr) ?? 0,
      setRegister: (addr: number, value: number) => {
        regs.set(addr, value);
        writes.push([addr, value]);
      },
    },
    { host: '127.0.0.1', port, unitID: 1 },
  );
  await new Promise<void>((resolve, reject) => {
    server.on('initialized', () => resolve());
    server.on('serverError', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
