import { createRequire } from 'node:module';
import { SunSpecDevice, type House } from '@peak-guard/sim';
import type { SimClock } from './server.js';

const { ServerTCP } = createRequire(import.meta.url)(
  'modbus-serial',
) as typeof import('modbus-serial');

export interface MockModbusOptions {
  port: number;
  host?: string;
  /** "Inverter control via Modbus" switch; false makes writes fail with a Modbus exception. */
  controlEnabled: boolean;
}

/** Modbus TCP server exposing the simulated Gen24 SunSpec map (see SunSpecDevice). */
export function createModbusServer(house: House, clock: SimClock, opts: MockModbusOptions) {
  const device = new SunSpecDevice(house, () => clock.now(), {
    controlEnabled: opts.controlEnabled,
  });
  return new ServerTCP(
    {
      getHoldingRegister: (addr: number) => device.read(addr),
      setRegister: (addr: number, value: number) => device.write(addr, value),
    },
    { host: opts.host ?? '0.0.0.0', port: opts.port, unitID: 1 },
  );
}
