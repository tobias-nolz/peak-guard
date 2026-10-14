import { queryOptions } from '@tanstack/react-query';
import type { LiveSnapshot, Settings } from '@peak-guard/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(res.status, body.message ?? body.error ?? res.statusText);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

export interface IntervalDto {
  start: number;
  importWh: number | null;
  exportWh: number | null;
  avgImportKw: number | null;
  avgExportKw: number | null;
  completeness: number;
  quality: 'exact' | 'estimated' | 'partial' | 'missing';
  source: 'counter' | 'integrated' | 'none';
  sampleCount: number;
  maxImportW: number | null;
}

export type PeakCause =
  | 'battery_empty'
  | 'battery_limit'
  | 'battery_idle'
  | 'battery_charging'
  | 'sustained_load'
  | 'short_spike';

export interface TopPeakDto {
  start: number;
  kw: number;
  maxImportKw: number | null;
  quality: IntervalDto['quality'];
  causes: PeakCause[];
  flows: {
    avgLoadKw: number | null;
    avgPvKw: number | null;
    avgBatteryKw: number | null;
    socStart: number | null;
    socEnd: number | null;
    sustainedMinutes: number;
  } | null;
}

export interface MonthSummaryDto {
  month: string;
  peak: { start: number; kw: number } | null;
  billedKw: number;
  costEur: number;
  tariffId: string;
  top: TopPeakDto[];
  daily: { day: string; peakKw: number | null; peakStart: number | null; importKwh: number }[];
  quality: Record<string, number>;
  intervalCount: number;
}

export interface SeriesDto {
  resolutionS: number;
  /** [ts, gridW, loadW, pvW, batteryW, socPct] */
  points: [number, number | null, number | null, number | null, number | null, number | null][];
}

export interface YearSummaryDto {
  year: number;
  months: {
    month: string;
    peakKw: number | null;
    peakStart: number | null;
    billedKw: number | null;
    costEur: number | null;
    importKwh: number;
    intervalCount: number;
  }[];
  totalCostEur: number;
}

export interface AnalysisDto {
  count: number;
  maxKw: number | null;
  p50Kw: number | null;
  p95Kw: number | null;
  p99Kw: number | null;
  limitKw: number;
  aboveLimit: number;
  heatmap: { weekday: number; hour: number; value: number | null; count: number }[];
  histogram: { fromKw: number; toKw: number; count: number }[];
  duration: { pct: number; kw: number }[];
}

export interface HealthDto {
  ok: boolean;
  db: boolean;
  collectorHeartbeatAgeMs: number | null;
  liveClients: number;
}

export const api = {
  live: () => request<LiveSnapshot | null>('/api/live'),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (s: Settings) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  intervals: (from: number, to: number) =>
    request<IntervalDto[]>(`/api/intervals?from=${from}&to=${to}`),
  month: (month: string) => request<MonthSummaryDto>(`/api/months/${month}`),
  series: (from: number, to: number) => request<SeriesDto>(`/api/series?from=${from}&to=${to}`),
  health: () => request<HealthDto>('/api/health'),
  year: (year: number) => request<YearSummaryDto>(`/api/years/${year}`),
  analysis: (from: number, to: number, agg: 'max' | 'avg') =>
    request<AnalysisDto>(`/api/analysis?from=${from}&to=${to}&agg=${agg}`),
};

/** URLs for file downloads (served with content-disposition: attachment). */
export const exportUrl = {
  intervals: (from: number, to: number, format: 'csv' | 'json') =>
    `/api/export/intervals?from=${from}&to=${to}&format=${format}`,
  series: (from: number, to: number, format: 'csv' | 'json') =>
    `/api/export/series?from=${from}&to=${to}&format=${format}`,
};

export const settingsQuery = queryOptions({ queryKey: ['settings'], queryFn: api.settings });
export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: api.health,
  refetchInterval: 30_000,
});
export const intervalsQuery = (from: number, to: number) =>
  queryOptions({ queryKey: ['intervals', from, to], queryFn: () => api.intervals(from, to) });
export const monthQuery = (month: string) =>
  queryOptions({ queryKey: ['month', month], queryFn: () => api.month(month) });
export const seriesQuery = (from: number, to: number) =>
  queryOptions({ queryKey: ['series', from, to], queryFn: () => api.series(from, to) });
export const yearQuery = (year: number) =>
  queryOptions({ queryKey: ['year', year], queryFn: () => api.year(year) });
export const analysisQuery = (from: number, to: number, agg: 'max' | 'avg') =>
  queryOptions({
    queryKey: ['analysis', from, to, agg],
    queryFn: () => api.analysis(from, to, agg),
  });
