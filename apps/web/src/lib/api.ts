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

export interface MonthSummaryDto {
  month: string;
  peak: { start: number; kw: number } | null;
  billedKw: number;
  costEur: number;
  tariffId: string;
  top: { start: number; kw: number; maxImportKw: number | null; quality: string }[];
  daily: { day: string; peakKw: number | null; peakStart: number | null; importKwh: number }[];
  quality: Record<string, number>;
  intervalCount: number;
}

export interface SeriesDto {
  resolutionS: number;
  /** [ts, gridW, loadW, pvW, batteryW, socPct] */
  points: [number, number | null, number | null, number | null, number | null, number | null][];
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
