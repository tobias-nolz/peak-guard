import { createRequire } from 'node:module';

// modbus-serial is CommonJS (module.exports = class) but its typings declare an ES
// default export, which NodeNext resolution can't reconcile; require it directly.
const ModbusRTU = createRequire(import.meta.url)(
  'modbus-serial',
) as (typeof import('modbus-serial'))['default'];

/** Minimal register access used by the SunSpec layer (makes it testable without a network). */
export interface ModbusTransport {
  /** Read holding registers (0-based PDU address). */
  read(address: number, length: number): Promise<number[]>;
  /** Write holding registers (function 16). */
  write(address: number, values: number[]): Promise<void>;
  close(): Promise<void>;
}

export interface ModbusTcpOptions {
  host: string;
  port?: number;
  unitId?: number;
  timeoutMs?: number;
}

/**
 * Modbus TCP transport. Requests are strictly sequential — Fronius recommends at most two
 * in flight; one keeps the inverter's Modbus server happy.
 */
export class ModbusTcpTransport implements ModbusTransport {
  private readonly client = new ModbusRTU();
  private queue: Promise<unknown> = Promise.resolve();
  private connected = false;

  constructor(private readonly opts: ModbusTcpOptions) {}

  private async ensure(): Promise<void> {
    if (this.connected && this.client.isOpen) return;
    await this.client.connectTCP(this.opts.host, { port: this.opts.port ?? 502 });
    this.client.setID(this.opts.unitId ?? 1);
    this.client.setTimeout(this.opts.timeoutMs ?? 3_000);
    this.connected = true;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      try {
        await this.ensure();
        return await fn();
      } catch (err) {
        // Force a reconnect on the next call.
        this.connected = false;
        try {
          this.client.close(() => {});
        } catch {
          /* already closed */
        }
        throw err;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  read(address: number, length: number): Promise<number[]> {
    return this.run(async () => (await this.client.readHoldingRegisters(address, length)).data);
  }

  write(address: number, values: number[]): Promise<void> {
    return this.run(async () => {
      await this.client.writeRegisters(address, values);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client.isOpen) return resolve();
      this.client.close(() => resolve());
    });
  }
}
