import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EChart, chartColors } from '@/components/echart';
import { MonthPicker } from '@/components/month-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { analysisQuery } from '@/lib/api';
import { fmtKw, fmtNumber, weekdayNames } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { monthBounds, monthOf, useNow } from '@/lib/time';

export function AnalysisView({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const [agg, setAgg] = useState<'max' | 'avg'>('max');
  const now = useNow();
  const { from, to } = monthBounds(month);
  const { data } = useQuery(analysisQuery(from, to, agg));

  const charts = useMemo(() => {
    const c = chartColors(dark);
    const axis = { axisLabel: { color: c.text }, axisLine: { lineStyle: { color: c.axis } } };
    const days = weekdayNames();
    const values = (data?.heatmap ?? []).map((h) => h.value ?? 0);
    const limitLine = (axisKey: 'xAxis' | 'yAxis') => ({
      symbol: 'none',
      silent: true,
      data: [
        {
          [axisKey]: data?.limitKw ?? 0,
          lineStyle: { color: c.limit, type: 'dashed' },
          label: { formatter: t('history.limit'), color: c.text, position: 'insideEndTop' },
        },
      ],
    });
    return {
      heatmap: {
        animation: false,
        grid: { left: 48, right: 16, top: 8, bottom: 96 },
        tooltip: {
          formatter: (p: { value: [number, number, number | null] }) =>
            `${days[p.value[1]]} ${String(p.value[0]).padStart(2, '0')}:00 – ${fmtKw(p.value[2])}`,
        },
        xAxis: {
          type: 'category',
          data: Array.from({ length: 24 }, (_, h) => String(h)),
          splitArea: { show: true },
          ...axis,
        },
        yAxis: { type: 'category', data: days, inverse: true, splitArea: { show: true }, ...axis },
        visualMap: {
          min: 0,
          max: Math.max(1, ...values),
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 4,
          itemHeight: 220,
          itemWidth: 12,
          textStyle: { color: c.text },
          inRange: {
            color: dark
              ? ['#1e293b', '#0ea5e9', '#f59e0b', '#ef4444']
              : ['#f1f5f9', '#38bdf8', '#f59e0b', '#dc2626'],
          },
        },
        series: [
          {
            type: 'heatmap',
            data: (data?.heatmap ?? []).map((h) => [
              h.hour,
              h.weekday,
              h.value == null ? null : Math.round(h.value * 100) / 100,
            ]),
          },
        ],
      },
      histogram: {
        animation: false,
        grid: { left: 48, right: 16, top: 16, bottom: 40 },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'value',
          name: 'kW',
          nameLocation: 'middle',
          nameGap: 26,
          nameTextStyle: { color: c.text },
          ...axis,
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          name: t('history.count'),
          nameTextStyle: { color: c.text },
          ...axis,
          splitLine: { lineStyle: { color: c.axis } },
        },
        series: [
          {
            type: 'bar',
            barWidth: '90%',
            color: c.house,
            data: (data?.histogram ?? []).map((b) => [(b.fromKw + b.toKw) / 2, b.count]),
            markLine: limitLine('xAxis'),
          },
        ],
      },
      duration: {
        animation: false,
        grid: { left: 48, right: 16, top: 16, bottom: 40 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmtKw(v) },
        xAxis: {
          type: 'value',
          min: 0,
          max: 100,
          name: t('history.durationAxis'),
          nameLocation: 'middle',
          nameGap: 26,
          nameTextStyle: { color: c.text },
          ...axis,
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          name: 'kW',
          nameTextStyle: { color: c.text },
          ...axis,
          splitLine: { lineStyle: { color: c.axis } },
        },
        series: [
          {
            type: 'line',
            showSymbol: false,
            color: c.grid,
            areaStyle: { opacity: 0.15 },
            data: (data?.duration ?? []).map((d) => [d.pct, d.kw]),
            markLine: limitLine('yAxis'),
          },
        ],
      },
    };
    // `t` changes with the language, which also re-localizes the weekday names.
  }, [data, dark, t]);

  return (
    <div className="space-y-4">
      <MonthPicker month={month} onChange={onMonth} max={monthOf(now)} />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label={t('history.max')} value={fmtKw(data?.maxKw)} />
        <Stat label={t('history.p99')} value={fmtKw(data?.p99Kw)} />
        <Stat label={t('history.p95')} value={fmtKw(data?.p95Kw)} />
        <Stat
          label={t('history.aboveLimit')}
          value={data ? `${data.aboveLimit} / ${data.count}` : '–'}
          sub={data ? `> ${fmtNumber(data.limitKw, 1)} kW` : undefined}
        />
      </div>
      {data?.count === 0 ? (
        <p className="text-muted-foreground py-12 text-center">{t('history.noData')}</p>
      ) : (
        <>
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>{t('history.heatmap')}</CardTitle>
              <Tabs value={agg} onValueChange={(v) => setAgg(v as 'max' | 'avg')}>
                <TabsList>
                  <TabsTrigger value="max">{t('history.heatmapAgg.max')}</TabsTrigger>
                  <TabsTrigger value="avg">{t('history.heatmapAgg.avg')}</TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              <EChart option={charts.heatmap} className="h-80" />
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('history.histogram')}</CardTitle>
              </CardHeader>
              <CardContent>
                <EChart option={charts.histogram} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('history.duration')}</CardTitle>
              </CardHeader>
              <CardContent>
                <EChart option={charts.duration} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent>
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
      </CardContent>
    </Card>
  );
}
