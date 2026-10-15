import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { INTERVAL_MS, activeFeeWindow } from '@peak-guard/core';
import { EChart, chartColors } from '@/components/echart';
import { ExportLinks } from '@/components/month-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { exportUrl, intervalsQuery, monthQuery, seriesQuery, settingsQuery } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtKw, fmtMonth, fmtNumber, fmtTime } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import {
  addDays,
  dateOf,
  dateToEpoch,
  lastDayOfMonth,
  monthBounds,
  monthOf,
  shiftMonth,
  useNow,
} from '@/lib/time';

/** 'today' is a single day (any day, despite the name kept for old URLs). */
export type RangeKind = 'today' | 'week' | 'month' | 'custom';
type DateRange = { from: string; to: string };

/** Epoch range for a kind anchored at `date` (the last day shown), never past `now`. */
export function resolveRange(kind: RangeKind, date: string, now: number, custom: DateRange) {
  const endOf = (d: string) => dateToEpoch(addDays(d, 1));
  switch (kind) {
    case 'today':
      return { from: dateToEpoch(date), to: endOf(date) };
    case 'week':
      return { from: dateToEpoch(addDays(date, -6)), to: Math.min(endOf(date), now) };
    case 'month': {
      const b = monthBounds(date.slice(0, 7));
      return { from: b.from, to: Math.min(b.to, now) };
    }
    case 'custom': {
      const from = dateToEpoch(custom.from);
      const to = endOf(custom.to);
      return to > from ? { from, to } : { from, to: endOf(custom.from) };
    }
  }
}

/** Anchor date one step (day, 7 days, month) earlier or later, clamped to today. */
function stepDate(kind: Exclude<RangeKind, 'custom'>, date: string, dir: -1 | 1, today: string) {
  const next =
    kind === 'today'
      ? addDays(date, dir)
      : kind === 'week'
        ? addDays(date, 7 * dir)
        : lastDayOfMonth(shiftMonth(date.slice(0, 7), dir));
  return next > today ? today : next;
}

const SERIES = ['grid', 'quarterHours', 'load', 'pv', 'battery', 'soc'] as const;
type SeriesId = (typeof SERIES)[number];
type Selection = Record<SeriesId, boolean>;
const SELECTION_KEY = 'peak-guard.history.series';

/** Series shown in the chart: all by default, the viewer's last choice if stored. */
function loadSelection(): Selection {
  const sel = Object.fromEntries(SERIES.map((s) => [s, true])) as Selection;
  try {
    const stored = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as unknown;
    if (stored && typeof stored === 'object') {
      for (const s of SERIES) {
        const v = (stored as Record<string, unknown>)[s];
        if (typeof v === 'boolean') sel[s] = v;
      }
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return sel;
}

function saveSelection(sel: Selection) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(sel));
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
}

interface TooltipParam {
  seriesId?: string;
  seriesName?: string;
  marker?: string;
  axisValue?: number | string;
  value?: [number, number | null];
}

const dot = (color: string) =>
  `<span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${color}"></span>`;

export function Timeline({
  kind,
  onKind,
  date: dateParam,
  onDate,
}: {
  kind: RangeKind;
  onKind: (k: RangeKind) => void;
  date: string | undefined;
  onDate: (date: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const now = useNow();
  const today = dateOf(now);
  const date = dateParam && dateParam < today ? dateParam : today;
  const [custom, setCustom] = useState(() => ({
    from: dateOf(now - 2 * 86_400_000),
    to: today,
  }));
  const [selection, setSelection] = useState(loadSelection);
  const { from, to } = resolveRange(kind, date, now, custom);

  const canNext =
    kind === 'custom'
      ? custom.to < today
      : kind === 'month'
        ? date.slice(0, 7) < today.slice(0, 7)
        : date < today;
  const step = (dir: -1 | 1) => {
    if (kind === 'custom') {
      // shift by the range's own length
      const days = Math.round((dateToEpoch(custom.to) - dateToEpoch(custom.from)) / 86_400_000) + 1;
      const next = { from: addDays(custom.from, dir * days), to: addDays(custom.to, dir * days) };
      if (next.to <= today) setCustom(next);
      return;
    }
    const next = stepDate(kind, date, dir, today);
    onDate(next === today ? undefined : next);
  };
  const rangeLabel =
    kind === 'today'
      ? fmtDate(from, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
      : kind === 'week'
        ? `${fmtDate(from)} – ${fmtDate(dateToEpoch(date), { day: '2-digit', month: '2-digit', year: 'numeric' })}`
        : kind === 'month'
          ? fmtMonth(date.slice(0, 7))
          : null;

  const series = useQuery(seriesQuery(from, to));
  const intervals = useQuery(intervalsQuery(from, to));
  const settings = useQuery(settingsQuery);
  const month = useQuery(monthQuery(monthOf(Math.min(to, now))));

  const option = useMemo(() => {
    const c = chartColors(dark);
    const name = (id: SeriesId) => t(`history.${id}`);
    const byStart = new Map((intervals.data ?? []).map((i) => [i.start, i]));
    const limit = Math.max(
      settings.data?.thresholdKw ?? 0,
      settings.data?.tariffs[0]?.minBilledKw ?? 0,
    );
    const kw = (w: number | null) => (w == null ? null : Math.round(w) / 1000);
    const pts = series.data?.points ?? [];
    // Step line: hold each quarter-hour's average for its full 15 minutes.
    const steps = (intervals.data ?? []).flatMap((i) => [
      [i.start, i.avgImportKw],
      [i.start + INTERVAL_MS, i.avgImportKw],
    ]);
    const marks: object[] = [
      {
        yAxis: limit,
        lineStyle: { color: c.limit, type: 'dashed' },
        label: { formatter: t('history.limit'), position: 'insideEndTop', color: c.text },
      },
    ];
    if (month.data?.peak) {
      marks.push({
        yAxis: month.data.peak.kw,
        lineStyle: { color: c.peak, type: 'dashed' },
        label: { formatter: t('history.monthPeak'), position: 'insideEndTop', color: c.text },
      });
    }
    const line = (id: SeriesId, color: string, idx: number, extra: object = {}) => ({
      id,
      name: name(id),
      type: 'line',
      showSymbol: false,
      sampling: 'lttb',
      lineStyle: { width: 1 },
      color,
      data: pts.map((p) => [p[0], kw(p[idx] as number | null)]),
      ...extra,
    });
    // Time-variable grid fee windows as background bands.
    const feeBands: [{ xAxis: number; name: string }, { xAxis: number }][] = [];
    const windows = settings.data?.gridFeeWindows ?? [];
    if (windows.length && to - from <= 40 * 86_400_000) {
      let open: { start: number; label: string } | null = null;
      for (let ts = from; ts <= to; ts += INTERVAL_MS) {
        const w = ts < to ? activeFeeWindow(ts, windows) : null;
        if (open && w?.label !== open.label) {
          feeBands.push([{ xAxis: open.start, name: open.label }, { xAxis: ts }]);
          open = null;
        }
        if (w && !open) open = { start: ts, label: w.label };
      }
    }
    const multiDay = to - from > 2 * 86_400_000;
    return {
      animation: false,
      legend: {
        top: 0,
        textStyle: { color: c.text },
        selected: Object.fromEntries(SERIES.map((s) => [name(s), selection[s]])),
      },
      grid: { left: 44, right: 44, top: 36, bottom: 64 },
      tooltip: {
        trigger: 'axis',
        // ECharts lists only the series nearest the cursor, which leaves out the 15-min
        // line (one point per quarter-hour); look the quarter-hour up directly instead.
        formatter: (raw: TooltipParam | TooltipParam[]) => {
          const params = Array.isArray(raw) ? raw : [raw];
          const ts = Number(params[0]?.axisValue ?? params[0]?.value?.[0]);
          if (!Number.isFinite(ts)) return '';
          const lines = [fmtDateTime(ts)];
          if (selection.quarterHours) {
            const start = Math.floor(ts / INTERVAL_MS) * INTERVAL_MS;
            const avg = byStart.get(start)?.avgImportKw ?? null;
            lines.push(
              `${dot(c.over)}${name('quarterHours')} (${fmtTime(start)} – ${fmtTime(start + INTERVAL_MS)}): <b>${fmtKw(avg)}</b>`,
            );
          }
          for (const p of params) {
            if (p.seriesId === 'quarterHours') continue;
            const v = p.value?.[1] ?? null;
            const text =
              p.seriesId === 'soc' ? (v == null ? '–' : `${fmtNumber(v, 0)} %`) : fmtKw(v);
            lines.push(`${p.marker ?? ''}${p.seriesName ?? ''}: <b>${text}</b>`);
          }
          return lines.join('<br/>');
        },
      },
      xAxis: {
        type: 'time',
        min: from,
        max: to,
        axisLabel: {
          color: c.text,
          formatter: (v: number) => (multiDay ? fmtDate(v) : fmtTime(v)),
        },
        axisLine: { lineStyle: { color: c.axis } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'kW',
          axisLabel: { color: c.text },
          nameTextStyle: { color: c.text },
          splitLine: { lineStyle: { color: c.axis } },
        },
        {
          type: 'value',
          name: '%',
          min: 0,
          max: 100,
          axisLabel: { color: c.text },
          nameTextStyle: { color: c.text },
          splitLine: { show: false },
        },
      ],
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 20, bottom: 8 }],
      series: [
        line('grid', c.grid, 1, { areaStyle: { opacity: 0.08 } }),
        {
          id: 'quarterHours',
          name: name('quarterHours'),
          type: 'line',
          step: false,
          showSymbol: false,
          color: c.over,
          lineStyle: { width: 2 },
          data: steps,
          markLine: { symbol: 'none', silent: true, data: marks },
          markArea: {
            silent: true,
            itemStyle: { color: dark ? 'rgba(56,189,248,0.08)' : 'rgba(14,165,233,0.08)' },
            label: { color: c.text, fontSize: 10 },
            data: feeBands,
          },
        },
        line('load', c.house, 2),
        line('pv', c.pv, 3),
        line('battery', c.battery, 4),
        {
          ...line('soc', c.battery, 5),
          yAxisIndex: 1,
          lineStyle: { width: 1, type: 'dotted' },
          data: pts.map((p) => [p[0], p[5]]),
        },
      ],
    };
  }, [series.data, intervals.data, settings.data, month.data, dark, from, to, t, selection]);

  const onEvents = useMemo(
    () => ({
      legendselectchanged: (params: unknown) => {
        const selected = (params as { selected: Record<string, boolean> }).selected;
        const next = Object.fromEntries(
          SERIES.map((s) => [s, selected[t(`history.${s}`)] ?? true]),
        ) as Selection;
        setSelection(next);
        saveSelection(next);
      },
    }),
    [t],
  );

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{t('history.tabs.timeline')}</CardTitle>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={kind} onValueChange={(v) => onKind(v as RangeKind)}>
            <TabsList>
              {(['today', 'week', 'month', 'custom'] as const).map((k) => (
                <TabsTrigger key={k} value={k}>
                  {t(`history.range.${k}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label={t('history.prev')}
              onClick={() => step(-1)}
            >
              <ChevronLeft />
            </Button>
            {rangeLabel && (
              <span className="min-w-36 text-center font-medium" data-testid="range-label">
                {rangeLabel}
              </span>
            )}
            <Button
              variant="outline"
              size="icon"
              aria-label={t('history.next')}
              disabled={!canNext}
              onClick={() => step(1)}
            >
              <ChevronRight />
            </Button>
          </div>
          {kind === 'custom' && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                aria-label={t('history.range.from')}
                className="w-40"
                value={custom.from}
                max={custom.to}
                onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
              />
              <span>–</span>
              <Input
                type="date"
                aria-label={t('history.range.to')}
                className="w-40"
                value={custom.to}
                min={custom.from}
                onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
              />
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <EChart option={option} className="h-96" onEvents={onEvents} />
        <ExportLinks
          links={[
            {
              label: `${t('history.exportIntervals')} (CSV)`,
              href: exportUrl.intervals(from, to, 'csv'),
            },
            {
              label: `${t('history.exportIntervals')} (JSON)`,
              href: exportUrl.intervals(from, to, 'json'),
            },
            {
              label: `${t('history.exportSeries')} (CSV)`,
              href: exportUrl.series(from, to, 'csv'),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}
