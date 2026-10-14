import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EChart, chartColors } from '@/components/echart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { monthQuery, settingsQuery, yearQuery } from '@/lib/api';
import { fmtEur, fmtKw, fmtMonth } from '@/lib/format';
import { monthOf, useNow } from '@/lib/time';
import { useTheme } from '@/lib/theme';

const COMPARE_COLORS = ['#3b82f6', '#f59e0b', '#22c55e'];

export function YearView({ year, onYear }: { year: number; onYear: (y: number) => void }) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const { data } = useQuery(yearQuery(year));
  const settings = useQuery(settingsQuery);
  const limit = Math.max(
    settings.data?.thresholdKw ?? 0,
    settings.data?.tariffs[0]?.minBilledKw ?? 0,
  );
  const [compare, setCompare] = useState<string[]>([]);
  const months = useMemo(() => data?.months ?? [], [data]);
  const currentYear = Number(monthOf(useNow()).slice(0, 4));
  const compared = useQueries({ queries: compare.map((m) => monthQuery(m)) });

  const yearOption = useMemo(() => {
    const c = chartColors(dark);
    return {
      animation: false,
      legend: { top: 0, textStyle: { color: c.text } },
      grid: { left: 44, right: 52, top: 36, bottom: 28 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: months.map((m) => fmtMonth(m.month, 'short')),
        axisLabel: { color: c.text },
        axisLine: { lineStyle: { color: c.axis } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'kW',
          nameTextStyle: { color: c.text },
          axisLabel: { color: c.text },
          splitLine: { lineStyle: { color: c.axis } },
        },
        {
          type: 'value',
          name: '€',
          nameTextStyle: { color: c.text },
          axisLabel: { color: c.text },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: t('history.peak'),
          type: 'bar',
          data: months.map((m) => ({
            value: m.peakKw,
            itemStyle: { color: (m.peakKw ?? 0) > limit ? c.over : c.house },
          })),
          tooltip: { valueFormatter: (v: number | null) => fmtKw(v) },
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              {
                yAxis: limit,
                lineStyle: { color: c.limit, type: 'dashed' },
                label: { formatter: t('history.limit'), position: 'insideEndTop', color: c.text },
              },
            ],
          },
        },
        {
          name: t('history.cost'),
          type: 'line',
          yAxisIndex: 1,
          color: c.peak,
          data: months.map((m) => m.costEur),
          tooltip: { valueFormatter: (v: number | null) => fmtEur(v) },
        },
      ],
    };
  }, [months, dark, limit, t]);

  const compareOption = useMemo(() => {
    const c = chartColors(dark);
    return {
      animation: false,
      legend: { top: 0, textStyle: { color: c.text } },
      grid: { left: 40, right: 16, top: 36, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => fmtKw(v) },
      xAxis: {
        type: 'category',
        name: t('history.day'),
        data: Array.from({ length: 31 }, (_, i) => String(i + 1)),
        axisLabel: { color: c.text },
        axisLine: { lineStyle: { color: c.axis } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: c.text },
        splitLine: { lineStyle: { color: c.axis } },
      },
      series: compare.map((m, k) => {
        const days = compared[k]?.data?.daily ?? [];
        const byDay = new Map(days.map((d) => [Number(d.day.slice(8)), d.peakKw]));
        return {
          name: fmtMonth(m, 'short'),
          type: 'line',
          color: COMPARE_COLORS[k],
          connectNulls: false,
          data: Array.from({ length: 31 }, (_, i) => byDay.get(i + 1) ?? null),
        };
      }),
    };
  }, [compare, compared, dark, t]);

  const toggle = (m: string) =>
    setCompare((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m].slice(-3)));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          aria-label={t('history.prev')}
          onClick={() => onYear(year - 1)}
        >
          <ChevronLeft />
        </Button>
        <span className="min-w-20 text-center font-medium">{year}</span>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('history.next')}
          onClick={() => onYear(year + 1)}
          disabled={year >= currentYear}
        >
          <ChevronRight />
        </Button>
        <span className="text-muted-foreground ml-4 text-sm" data-testid="year-cost">
          {t('history.yearCost', { year })}: {fmtEur(data?.totalCostEur ?? null)}
        </span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('history.monthlyPeaks')}</CardTitle>
        </CardHeader>
        <CardContent>
          <EChart option={yearOption} className="h-72" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('history.compare')}</CardTitle>
          <CardDescription>{t('history.compareHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {months
              .filter((m) => m.intervalCount > 0)
              .map((m) => (
                <Button
                  key={m.month}
                  size="sm"
                  variant={compare.includes(m.month) ? 'default' : 'outline'}
                  onClick={() => toggle(m.month)}
                  aria-pressed={compare.includes(m.month)}
                >
                  {fmtMonth(m.month, 'short')}
                </Button>
              ))}
          </div>
          {compare.length > 0 && <EChart option={compareOption} className="h-64" />}
        </CardContent>
      </Card>
    </div>
  );
}
