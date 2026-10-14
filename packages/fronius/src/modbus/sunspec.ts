import type { ModbusTransport } from './transport.js';

/**
 * SunSpec helpers for Fronius Gen24 (Modbus TCP, unit 1).
 *
 * Addresses here are 0-based PDU addresses: the "SunS" marker sits at 40000, which
 * Fronius documentation calls register 40001. The model chain is walked at runtime, so
 * the int+SF and float register layouts (and firmware differences) are both handled.
 */

export const SUNSPEC_BASE = 40_000;
export const SUNSPEC_END = 0xffff;

export interface ModelInfo {
  id: number;
  /** Address of the model's ID register. */
  address: number;
  /** Model length in registers (excluding ID and L). */
  length: number;
}

/** Walk the SunSpec model chain. */
export async function discoverModels(
  t: ModbusTransport,
  base = SUNSPEC_BASE,
  maxModels = 64,
): Promise<ModelInfo[]> {
  const marker = await t.read(base, 2);
  if (marker[0] !== 0x5375 || marker[1] !== 0x6e53) {
    throw new Error(
      `no SunSpec marker at ${base} (got ${marker.map((x) => x.toString(16)).join(' ')})`,
    );
  }
  const models: ModelInfo[] = [];
  let addr = base + 2;
  for (let i = 0; i < maxModels; i++) {
    const [id, length] = (await t.read(addr, 2)) as [number, number];
    if (id === SUNSPEC_END || id === undefined) return models;
    models.push({ id, address: addr, length });
    addr += 2 + length;
  }
  throw new Error('SunSpec model chain did not terminate');
}

const int16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);
const uint16 = (v: number) => v & 0xffff;
/** "Not implemented" markers. */
const NI_U16 = 0xffff;
const NI_I16 = -0x8000;

/** Model 124 (Basic Storage Controls) register offsets, relative to the first data register. */
export const M124 = {
  WChaMax: 0,
  WChaGra: 1,
  WDisChaGra: 2,
  StorCtl_Mod: 3,
  VAChaMax: 4,
  MinRsvPct: 5,
  ChaState: 6,
  StorAval: 7,
  InBatV: 8,
  ChaSt: 9,
  OutWRte: 10,
  InWRte: 11,
  InOutWRte_WinTms: 12,
  InOutWRte_RvrtTms: 13,
  InOutWRte_RmpTms: 14,
  ChaGriSet: 15,
  WChaMax_SF: 16,
  WChaDisChaGra_SF: 17,
  VAChaMax_SF: 18,
  MinRsvPct_SF: 19,
  ChaState_SF: 20,
  StorAval_SF: 21,
  InBatV_SF: 22,
  InOutWRte_SF: 23,
} as const;
export const M124_LENGTH = 24;

export const CHA_ST = [
  '',
  'OFF',
  'EMPTY',
  'DISCHARGING',
  'CHARGING',
  'FULL',
  'HOLDING',
  'TESTING',
] as const;

export interface StorageState {
  /** Address of the model's first data register (after ID and L). */
  dataAddress: number;
  wChaMaxW: number | null;
  storCtlMod: number;
  minRsvPct: number | null;
  chaStatePct: number | null;
  chaSt: string | null;
  outWRtePct: number | null;
  inWRtePct: number | null;
  winTmsS: number | null;
  rvrtTmsS: number | null;
  rmpTmsS: number | null;
  chaGriSet: number | null;
  /** Scale factor exponent for InWRte/OutWRte (needed to encode writes). */
  inOutWRteSf: number;
}

function scaled(raw: number, sf: number, signed: boolean): number | null {
  if (signed ? int16(raw) === NI_I16 : raw === NI_U16) return null;
  if (int16(sf) === NI_I16) return null;
  return (signed ? int16(raw) : raw) * 10 ** int16(sf);
}

/** Read and decode model 124. `model` must be the chain entry with id 124. */
export async function readStorage(t: ModbusTransport, model: ModelInfo): Promise<StorageState> {
  if (model.id !== 124) throw new Error(`model ${model.id} is not 124`);
  if (model.length < M124_LENGTH) throw new Error(`model 124 too short (${model.length})`);
  const dataAddress = model.address + 2;
  const r = await t.read(dataAddress, M124_LENGTH);
  const at = (k: keyof typeof M124) => r[M124[k]]!;
  const sf = int16(at('InOutWRte_SF'));
  const u = (k: keyof typeof M124) => (at(k) === NI_U16 ? null : at(k));
  const chaSt = u('ChaSt');
  return {
    dataAddress,
    wChaMaxW: scaled(at('WChaMax'), at('WChaMax_SF'), false),
    storCtlMod: at('StorCtl_Mod') === NI_U16 ? 0 : at('StorCtl_Mod'),
    minRsvPct: scaled(at('MinRsvPct'), at('MinRsvPct_SF'), false),
    chaStatePct: scaled(at('ChaState'), at('ChaState_SF'), false),
    chaSt: chaSt == null ? null : (CHA_ST[chaSt] ?? String(chaSt)),
    outWRtePct: scaled(at('OutWRte'), at('InOutWRte_SF'), true),
    inWRtePct: scaled(at('InWRte'), at('InOutWRte_SF'), true),
    winTmsS: u('InOutWRte_WinTms'),
    rvrtTmsS: u('InOutWRte_RvrtTms'),
    rmpTmsS: u('InOutWRte_RmpTms'),
    chaGriSet: u('ChaGriSet'),
    inOutWRteSf: sf === NI_I16 ? 0 : sf,
  };
}

export interface StorageCommand {
  /** bit0 charge limit, bit1 discharge limit; 0 = inverter's own mode */
  storCtlMod: number;
  /** discharge limit in % of WChaMax (≥ 0 only: never forced charging) */
  outWRtePct: number;
  /** charge limit in % of WChaMax (≥ 0 only: never forced discharging) */
  inWRtePct: number;
  /** revert timeout (s); 0 = none */
  rvrtTmsS: number;
}

/** The inverter's default: no limits active, rates at 100 %. */
export const STORAGE_DEFAULTS: StorageCommand = {
  storCtlMod: 0,
  outWRtePct: 100,
  inWRtePct: 100,
  rvrtTmsS: 0,
};

/**
 * Register writes for a storage command. Rates are written first, then StorCtl_Mod, so
 * a limit never becomes active with a stale rate. Negative rates (forced charge or
 * discharge) are rejected by design.
 */
export function encodeStorageCommand(
  cmd: StorageCommand,
  state: Pick<StorageState, 'dataAddress' | 'inOutWRteSf'>,
) {
  for (const [k, v] of [
    ['outWRtePct', cmd.outWRtePct],
    ['inWRtePct', cmd.inWRtePct],
  ] as const) {
    if (!(v >= 0 && v <= 100))
      throw new Error(
        `${k} must be within 0..100 % (got ${v}); forced charging/discharging is not allowed`,
      );
  }
  if (!Number.isInteger(cmd.storCtlMod) || cmd.storCtlMod < 0 || cmd.storCtlMod > 3)
    throw new Error('invalid StorCtl_Mod');
  if (!(cmd.rvrtTmsS >= 0 && cmd.rvrtTmsS <= 0xfffe)) throw new Error('invalid revert timeout');
  const toRaw = (pct: number) => uint16(Math.round(pct / 10 ** state.inOutWRteSf));
  return [
    // OutWRte, InWRte, InOutWRte_WinTms (0 = immediately), InOutWRte_RvrtTms
    {
      address: state.dataAddress + M124.OutWRte,
      values: [toRaw(cmd.outWRtePct), toRaw(cmd.inWRtePct), 0, Math.round(cmd.rvrtTmsS)],
    },
    { address: state.dataAddress + M124.StorCtl_Mod, values: [cmd.storCtlMod] },
  ];
}

export async function writeStorage(
  t: ModbusTransport,
  cmd: StorageCommand,
  state: StorageState,
): Promise<void> {
  for (const w of encodeStorageCommand(cmd, state)) await t.write(w.address, w.values);
}
