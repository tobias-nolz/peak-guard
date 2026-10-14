import { z } from 'zod';

/**
 * Fronius Solar API v1 (read-only HTTP JSON API).
 *
 * Shapes follow Gen24 firmware 1.2x–1.4x responses. Schemas are deliberately loose
 * (unknown keys kept, most fields optional) because field sets differ between firmware
 * versions and device types; mapping functions below decide what is required.
 */

const head = z.object({
  Status: z.object({
    Code: z.number(),
    Reason: z.string().optional(),
    UserMessage: z.string().optional(),
  }),
  Timestamp: z.string(),
});

const num = z.number().nullable().optional();

export const powerFlowSchema = z.object({
  Head: head,
  Body: z.object({
    Data: z.object({
      Site: z.looseObject({
        Mode: z.string().optional(),
        Meter_Location: z.string().optional(),
        /** + import from grid, − export (W) */
        P_Grid: num,
        /** − consumption (W) */
        P_Load: num,
        /** + PV production (W) */
        P_PV: num,
        /** + discharge, − charge (W) */
        P_Akku: num,
        BatteryStandby: z.boolean().optional(),
        BackupMode: z.boolean().optional(),
      }),
      Inverters: z.record(
        z.string(),
        z.looseObject({
          DT: z.number().optional(),
          P: num,
          SOC: num,
          Battery_Mode: z.string().optional(),
        }),
      ),
      Version: z.string().optional(),
    }),
  }),
});

const meterData = z.looseObject({
  Details: z
    .looseObject({
      Manufacturer: z.string().optional(),
      Model: z.string().optional(),
      Serial: z.string().optional(),
    })
    .optional(),
  Enable: z.number().optional(),
  Visible: z.number().optional(),
  /** 0 = grid / feed-in point, 1 = consumption path, 256-511 = sub-load, ... */
  Meter_Location_Current: z.number().optional(),
  /** + import, − export (W) at the meter */
  PowerReal_P_Sum: num,
  EnergyReal_WAC_Sum_Consumed: num,
  EnergyReal_WAC_Sum_Produced: num,
  EnergyReal_WAC_Plus_Absolute: num,
  EnergyReal_WAC_Minus_Absolute: num,
  SMARTMETER_ENERGYACTIVE_CONSUMED_SUM_F64: num,
  SMARTMETER_ENERGYACTIVE_PRODUCED_SUM_F64: num,
  SMARTMETER_POWERACTIVE_MEAN_SUM_F64: num,
  TimeStamp: z.number().optional(),
});

export const meterSystemSchema = z.object({
  Head: head,
  Body: z.object({ Data: z.record(z.string(), meterData) }),
});

export const storageSystemSchema = z.object({
  Head: head,
  Body: z.object({
    Data: z.record(
      z.string(),
      z.looseObject({
        Controller: z.looseObject({
          Capacity_Maximum: num,
          DesignedCapacity: num,
          StateOfCharge_Relative: num,
          Temperature_Cell: num,
          Enable: z.number().optional(),
          Details: z
            .looseObject({
              Manufacturer: z.string().optional(),
              Model: z.string().optional(),
              Serial: z.string().optional(),
            })
            .optional(),
        }),
      }),
    ),
  }),
});

export type PowerFlowResponse = z.infer<typeof powerFlowSchema>;
export type MeterSystemResponse = z.infer<typeof meterSystemSchema>;
export type StorageSystemResponse = z.infer<typeof storageSystemSchema>;

export interface MeterReading {
  meterId: string;
  model: string | null;
  /** + import, − export (W) */
  powerW: number;
  /** cumulative import from grid (Wh) */
  importWh: number | null;
  /** cumulative export to grid (Wh) */
  exportWh: number | null;
}

/** Select the grid (feed-in point) meter and normalise its readings. */
export function gridMeterFrom(res: MeterSystemResponse): MeterReading {
  const entries = Object.entries(res.Body.Data).filter(([, m]) => m.Enable !== 0);
  const grid =
    entries.find(([, m]) => m.Meter_Location_Current === 0) ??
    (entries.length === 1 ? entries[0] : undefined);
  if (!grid) throw new Error('no grid meter (Meter_Location_Current = 0) found');
  const [meterId, m] = grid;
  const powerW = m.PowerReal_P_Sum ?? m.SMARTMETER_POWERACTIVE_MEAN_SUM_F64;
  if (powerW == null) throw new Error(`meter ${meterId} reports no power`);
  return {
    meterId,
    model: m.Details?.Model ?? null,
    powerW,
    importWh:
      m.EnergyReal_WAC_Sum_Consumed ??
      m.SMARTMETER_ENERGYACTIVE_CONSUMED_SUM_F64 ??
      m.EnergyReal_WAC_Plus_Absolute ??
      null,
    exportWh:
      m.EnergyReal_WAC_Sum_Produced ??
      m.SMARTMETER_ENERGYACTIVE_PRODUCED_SUM_F64 ??
      m.EnergyReal_WAC_Minus_Absolute ??
      null,
  };
}

export interface PowerFlowReading {
  gridW: number | null;
  /** house consumption, positive (W) */
  loadW: number | null;
  pvW: number | null;
  /** + discharge, − charge (W) */
  batteryW: number | null;
  socPct: number | null;
  batteryMode: string | null;
}

export function powerFlowFrom(res: PowerFlowResponse): PowerFlowReading {
  const site = res.Body.Data.Site;
  const inv =
    Object.values(res.Body.Data.Inverters).find((i) => i.SOC != null) ??
    Object.values(res.Body.Data.Inverters)[0];
  return {
    gridW: site.P_Grid ?? null,
    loadW: site.P_Load == null ? null : -site.P_Load,
    pvW: site.P_PV ?? 0,
    batteryW: site.P_Akku ?? null,
    socPct: inv?.SOC ?? null,
    batteryMode: inv?.Battery_Mode ?? null,
  };
}

export interface StorageInfo {
  capacityWh: number | null;
  designedCapacityWh: number | null;
  socPct: number | null;
  manufacturer: string | null;
  model: string | null;
}

export function storageFrom(res: StorageSystemResponse): StorageInfo | null {
  const first = Object.values(res.Body.Data)[0];
  if (!first) return null;
  const c = first.Controller;
  return {
    capacityWh: c.Capacity_Maximum ?? null,
    designedCapacityWh: c.DesignedCapacity ?? null,
    socPct: c.StateOfCharge_Relative ?? null,
    manufacturer: c.Details?.Manufacturer ?? null,
    model: c.Details?.Model ?? null,
  };
}

export class SolarApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SolarApiError';
  }
}

export interface SolarApiClientOptions {
  /** e.g. http://192.168.1.50 */
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class SolarApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SolarApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  powerFlow(): Promise<PowerFlowResponse> {
    return this.get('/solar_api/v1/GetPowerFlowRealtimeData.fcgi', powerFlowSchema);
  }

  meters(): Promise<MeterSystemResponse> {
    return this.get('/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System', meterSystemSchema);
  }

  storage(): Promise<StorageSystemResponse> {
    return this.get('/solar_api/v1/GetStorageRealtimeData.cgi?Scope=System', storageSystemSchema);
  }

  private async get<T extends { Head: { Status: { Code: number; Reason?: string | undefined } } }>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new SolarApiError(`HTTP ${res.status} for ${path}`);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success)
      throw new SolarApiError(`unexpected response for ${path}: ${parsed.error.message}`);
    const status = parsed.data.Head.Status;
    if (status.Code !== 0)
      throw new SolarApiError(
        `Solar API error ${status.Code}: ${status.Reason ?? ''}`,
        status.Code,
      );
    return parsed.data;
  }
}
