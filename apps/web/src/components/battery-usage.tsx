import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EChart, chartColors } from '@/components/echart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { batteryQuery, type BatteryUsageDto } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const DISCHARGE_COLOR = '#14b8a6';

const fmtKwh = (v: number | null | undefined) => (v == null ? '–' : `${fmtNumber(v, 1)} kWh`);
const fmtCycles = (v: number | null | undefined) => fmtNumber(v, 2);

/** Hover text explaining how cycles are counted (or why they aren't). */
function useCyclesHint(capacityKwh: number | null | undefined) {
  const { t } = useTranslation();
  return capacityKwh
    ? t('batteryUsage.cyclesHint', { kwh: fmtNumber(capacityKwh, 1) })
    : t('batteryUsage.noCapacity');
}

/** Charged, discharged and equivalent full cycles in a compact row. */
export function BatteryStats({
  usage,
  capacityKwh,
  label,
  className,
  testId,
}: {
  usage: BatteryUsageDto;
  capacityKwh: number | null;
  /** optional heading in front of the numbers */
  label?: string;
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const hint = useCyclesHint(capacityKwh);
  return (
    <div className={cn('flex flex-wrap items-end gap-x-6 gap-y-1', className)} data-testid={testId}>
      {label && <span className="text-sm font-medium">{label}</span>}
      <Stat label={t('batteryUsage.charged')} value={fmtKwh(usage.chargeKwh)} />
      <Stat label={t('batteryUsage.discharged')} value={fmtKwh(usage.dischargeKwh)} />
      <Stat label={t('batteryUsage.cycles')} value={fmtCycles(usage.cycles)} title={hint} />
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-medium tabular-nums">{value}</div>
    </div>
  );
}

/** Battery totals for [from, to), hidden while there is no battery data. */
export function BatteryRangeStats({
  from,
  to,
  refetchInterval,
  label,
  className,
  testId,
}: {
  from: number;
  to: number;
  refetchInterval?: number;
  label?: string;
  className?: string;
  testId?: string;
}) {
  const { data } = useQuery({
    ...batteryQuery(from, to),
    ...(refetchInterval ? { refetchInterval } : {}),
  });
  if (!data || data.total.minutes === 0) return null;
  return (
    <BatteryStats
      usage={data.total}
      capacityKwh={data.capacityKwh}
      label={label}
      className={className}
      testId={testId}
    />
  );
}

/** Charged/discharged energy and cycles per day (of a month) or per month (of a year). */
export function BatteryUsageCard({
  from,
  to,
  by,
  categories,
}: {
  from: number;
  to: number;
  by: 'day' | 'month';
  /** one bar group per period key ("YYYY-MM-DD" or "YYYY-MM") */
  categories: { key: string; label: string }[];
}) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const { data } = useQuery(batteryQuery(from, to, by));
  const hint = useCyclesHint(data?.capacityKwh);

  const option = useMemo(() => {
    const c = chartColors(dark);
    const byKey = new Map((data?.periods ?? []).map((p) => [p.period, p]));
    const pick = (k: 'chargeKwh' | 'dischargeKwh' | 'cycles') =>
      categories.map((cat) => byKey.get(cat.key)?.[k] ?? null);
    return {
      animation: false,
      legend: { top: 0, textStyle: { color: c.text } },
      grid: { left: 44, right: 44, top: 36, bottom: 28 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category',
        data: categories.map((cat) => cat.label),
        axisLabel: { color: c.text },
        axisLine: { lineStyle: { color: c.axis } },
      },
      yAxis: [
        {
          type: 'value',
          name: 'kWh',
          nameTextStyle: { color: c.text },
          axisLabel: { color: c.text },
          splitLine: { lineStyle: { color: c.axis } },
        },
        {
          type: 'value',
          name: t('batteryUsage.cycles'),
          nameTextStyle: { color: c.text },
          axisLabel: { color: c.text },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: t('batteryUsage.charged'),
          type: 'bar',
          color: c.battery,
          data: pick('chargeKwh'),
          tooltip: { valueFormatter: (v: number | null) => fmtKwh(v) },
        },
        {
          name: t('batteryUsage.discharged'),
          type: 'bar',
          color: DISCHARGE_COLOR,
          data: pick('dischargeKwh'),
          tooltip: { valueFormatter: (v: number | null) => fmtKwh(v) },
        },
        {
          name: t('batteryUsage.cycles'),
          type: 'line',
          yAxisIndex: 1,
          color: c.grid,
          data: pick('cycles'),
          tooltip: { valueFormatter: (v: number | null) => fmtCycles(v) },
        },
      ],
    };
  }, [data, categories, dark, t]);

  return (
    <Card data-testid="battery-usage">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle>{t('batteryUsage.title')}</CardTitle>
          <CardDescription>{hint}</CardDescription>
        </div>
        {data && <BatteryStats usage={data.total} capacityKwh={data.capacityKwh} />}
      </CardHeader>
      <CardContent>
        {data && data.total.minutes === 0 ? (
          <p className="text-muted-foreground py-8 text-center">{t('history.noData')}</p>
        ) : (
          <EChart option={option} className="h-64" />
        )}
      </CardContent>
    </Card>
  );
}
