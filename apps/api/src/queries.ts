import type { CauseSample } from '@peak-guard/core';
import type { Sql } from '@peak-guard/db';

/** [ts, gridW, loadW, pvW, batteryW, socPct] */
export type SeriesPoint = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

// Drizzle replaces postgres.js' Date/array serializers on the shared client, so bind
// timestamps as ISO strings and lists as one comma-separated string.
const iso = (ms: number) => new Date(ms).toISOString();
const n = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);

interface Row {
  ts: Date | string;
  grid: number | null;
  load: number | null;
  pv: number | null;
  bat: number | null;
  soc: number | null;
}

const toPoint = (r: Row): SeriesPoint => [
  new Date(r.ts).getTime(),
  n(r.grid),
  n(r.load),
  n(r.pv),
  n(r.bat),
  n(r.soc),
];

/** Pick a resolution so a range stays below a few thousand points. */
export function autoResolution(spanMs: number): number {
  if (spanMs <= 6 * 3_600_000) return 10;
  if (spanMs <= 8 * 86_400_000) return 60;
  return 900;
}

/** Power series in [from, to) at `resolutionS` (10 s from raw samples, ≥ 60 s from the 1-minute aggregate). */
export async function series(
  sql: Sql,
  from: number,
  to: number,
  resolutionS: number,
): Promise<SeriesPoint[]> {
  const bucket = `${resolutionS} seconds`;
  const rows =
    resolutionS < 60
      ? await sql<Row[]>`
          SELECT time_bucket(${bucket}::interval, ts) AS ts, avg(grid_w) AS grid, avg(load_w) AS load,
                 avg(pv_w) AS pv, avg(battery_w) AS bat, last(soc_pct, ts) AS soc
          FROM samples WHERE ts >= ${iso(from)} AND ts < ${iso(to)} GROUP BY 1 ORDER BY 1`
      : await sql<Row[]>`
          SELECT time_bucket(${bucket}::interval, bucket) AS ts, avg(grid_w_avg) AS grid, avg(load_w_avg) AS load,
                 avg(pv_w_avg) AS pv, avg(battery_w_avg) AS bat, last(soc_pct, bucket) AS soc
          FROM samples_1m WHERE bucket >= ${iso(from)} AND bucket < ${iso(to)} GROUP BY 1 ORDER BY 1`;
  return rows.map(toPoint);
}

/** 1-minute power flows for a set of quarter-hours (for cause analysis), keyed by interval start. */
export async function flowsForIntervals(
  sql: Sql,
  starts: readonly number[],
): Promise<Map<number, CauseSample[]>> {
  const out = new Map<number, CauseSample[]>(starts.map((s) => [s, []]));
  if (starts.length === 0) return out;
  const rows = await sql<(Row & { interval_start: Date | string })[]>`
    SELECT time_bucket('15 minutes', bucket) AS interval_start, bucket AS ts, grid_w_avg AS grid,
           load_w_avg AS load, pv_w_avg AS pv, battery_w_avg AS bat, soc_pct AS soc
    FROM samples_1m
    WHERE bucket >= ${iso(Math.min(...starts))} AND bucket < ${iso(Math.max(...starts) + 15 * 60_000)}
      AND time_bucket('15 minutes', bucket) = ANY(string_to_array(${starts.map(iso).join(',')}, ',')::timestamptz[])
    ORDER BY bucket`;
  for (const r of rows) {
    const p = toPoint(r);
    out.get(new Date(r.interval_start).getTime())?.push({
      ts: p[0],
      gridW: p[1] ?? 0,
      loadW: p[2],
      pvW: p[3],
      batteryW: p[4],
      socPct: p[5],
    });
  }
  return out;
}
