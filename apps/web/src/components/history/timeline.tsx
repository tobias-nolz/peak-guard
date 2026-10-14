import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { INTERVAL_MS } from '@peak-guard/core';
import { EChart, chartColors } from '@/components/echart';
import { ExportLinks } from '@/components/month-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { exportUrl, intervalsQuery, monthQuery, seriesQuery, settingsQuery } from '@/lib/api';
import { fmtDate, fmtKw, fmtTime } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { dateOf, dateToEpoch, monthBounds, monthOf, useNow } from '@/lib/time';

export type RangeKind = 'today' | 'week' | 'month' | 'custom';

export function resolveRange(kind: RangeKind, now: number, custom: { from: string; to: string }) {
  const today = dateToEpoch(dateOf(now));
  switch (kind) {
    case 'today':
      return { from: today, to: today + 86_400_000 + 3_600_000 };
    case 'week':
      return { from: dateToEpoch(dateOf(now - 6 * 86_400_000)), to: now };
    case 'month':
      return { from: monthBounds(monthOf(now)).from, to: now };
    case 'custom': {
      const from = dateToEpoch(custom.from);
      const to = dateToEpoch(custom.to) + 86_400_000;
      return to > from ? { from, to } : { from, to: from + 86_400_000 };
    }
  }
}

export function Timeline({ kind, onKind }: { kind: RangeKind; onKind: (k: RangeKind) => void }) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const now = useNow();
  const [custom, setCustom] = useState(() => ({
    from: dateOf(now - 2 * 86_400_000),
    to: dateOf(now),
  }));
  const { from, to } = resolveRange(kind, now, custom);

  const series = useQuery(seriesQuery(from, to));
  const intervals = useQuery(intervalsQuery(from, to));
  const settings = useQuery(settingsQuery);
  const month = useQuery(monthQuery(monthOf(Math.min(to, now))));

  const option = useMemo(() => {
    const c = chartColors(dark);
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
    const line = (name: string, color: string, idx: number, extra: object = {}) => ({
      name,
      type: 'line',
      showSymbol: false,
      sampling: 'lttb',
      lineStyle: { width: 1 },
      color,
      data: pts.map((p) => [p[0], kw(p[idx] as number | null)]),
      ...extra,
    });
    const multiDay = to - from > 2 * 86_400_000;
    return {
      animation: false,
      legend: {
        top: 0,
        textStyle: { color: c.text },
        selected: {
          [t('history.load')]: false,
          [t('history.pv')]: false,
          [t('history.battery')]: false,
          [t('history.soc')]: false,
        },
      },
      grid: { left: 44, right: 44, top: 36, bottom: 64 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number | null) => (v == null ? '–' : fmtKw(v)),
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
        line(t('history.grid'), c.grid, 1, { areaStyle: { opacity: 0.08 } }),
        {
          name: t('history.quarterHours'),
          type: 'line',
          step: false,
          showSymbol: false,
          color: c.over,
          lineStyle: { width: 2 },
          data: steps,
          markLine: { symbol: 'none', silent: true, data: marks },
        },
        line(t('history.load'), c.house, 2),
        line(t('history.pv'), c.pv, 3),
        line(t('history.battery'), c.battery, 4),
        {
          ...line(t('history.soc'), c.battery, 5),
          yAxisIndex: 1,
          lineStyle: { width: 1, type: 'dotted' },
          data: pts.map((p) => [p[0], p[5]]),
        },
      ],
    };
  }, [series.data, intervals.data, settings.data, month.data, dark, from, to, t]);

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
        <EChart option={option} className="h-96" />
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
