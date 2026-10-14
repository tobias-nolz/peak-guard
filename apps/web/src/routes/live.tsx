import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { INTERVAL_MS, startOfLocalDay } from '@peak-guard/core';
import type { LiveSnapshot } from '@peak-guard/shared';
import { EChart, chartColors } from '@/components/echart';
import { IntervalGauge } from '@/components/interval-gauge';
import { PowerFlow } from '@/components/power-flow';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { intervalsQuery, settingsQuery } from '@/lib/api';
import { TIME_ZONE, fmtDuration, fmtEur, fmtKw, fmtNumber, fmtTime } from '@/lib/format';
import { useLiveContext } from '@/lib/live-context';
import { useTheme } from '@/lib/theme';

export function LivePage() {
  const { t } = useTranslation();
  const { snapshot } = useLiveContext();

  if (!snapshot) {
    return <p className="text-muted-foreground py-24 text-center">{t('live.waiting')}</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <IntervalCard snap={snapshot} className="lg:col-span-3" />
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{t('live.powerFlow')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PowerFlow power={snapshot.power} />
        </CardContent>
      </Card>
      <CostCard snap={snapshot} className="lg:col-span-2" />
      <TodayCard snap={snapshot} className="lg:col-span-3" />
    </div>
  );
}

function IntervalCard({ snap, className }: { snap: LiveSnapshot; className?: string }) {
  const { t } = useTranslation();
  const i = snap.interval;
  const stateVariant = snap.state;
  const progress = (i.elapsedMs / INTERVAL_MS) * 100;

  return (
    <Card className={className} data-testid="interval-card">
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle>{t('live.interval')}</CardTitle>
          <CardDescription>
            {fmtTime(i.start)} – {fmtTime(i.end)}
          </CardDescription>
        </div>
        {snap.feeWindow && (
          <Badge variant="outline" data-testid="fee-window-active">
            {t('fee.active', { label: snap.feeWindow })}
          </Badge>
        )}
        {snap.shed && snap.shed.length > 0 && (
          <Badge variant="warning" data-testid="shed-active">
            {t('shed.active', { names: snap.shed.join(', ') })}
          </Badge>
        )}
        <Badge variant={stateVariant} data-testid="interval-state">
          {t(`live.state.${snap.state}`)}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <div className="text-muted-foreground text-sm">{t('live.projected')}</div>
            <div
              className="text-5xl font-semibold tracking-tight tabular-nums"
              data-testid="projected-kw"
            >
              {fmtNumber(i.projectedKw, 2)}
              <span className="text-muted-foreground ml-1 text-2xl font-normal">kW</span>
            </div>
          </div>
          <Stat label={t('live.committed')} value={fmtKw(i.committedKw)} />
          <Stat label={t('live.runningAvg')} value={fmtKw(i.runningAvgKw)} />
          <Stat label={t('live.energy')} value={`${fmtNumber(i.importWh / 1000, 2)} kWh`} />
        </div>

        <IntervalGauge snap={snap} />

        <div className="space-y-1.5">
          <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
            <span>
              {t('live.elapsed')} {fmtDuration(i.elapsedMs)}
            </span>
            <span>
              {t('live.remaining')} {fmtDuration(i.remainingMs)}
            </span>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
          {i.completeness < 0.95 && i.elapsedMs > 30_000 && (
            <div className="text-warning text-xs">
              {t('live.completeness')}: {fmtNumber(i.completeness * 100, 0)} %
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-lg font-medium tabular-nums">{value}</div>
    </div>
  );
}

function CostCard({ snap, className }: { snap: LiveSnapshot; className?: string }) {
  const { t } = useTranslation();
  const { data: settings } = useQuery(settingsQuery);
  const minBilled = settings?.tariffs[0]?.minBilledKw;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t('live.costs')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Stat label={t('live.monthPeak')} value={fmtKw(snap.monthPeak?.kw ?? null)} />
          <Stat
            label={t('live.billed')}
            value={fmtKw(Math.max(snap.monthPeak?.kw ?? 0, minBilled ?? 0), 1)}
          />
          <Stat label={t('live.monthCost')} value={fmtEur(snap.monthCostEur)} />
          <div>
            <div className="text-muted-foreground text-xs">{t('live.extraCost')}</div>
            <div
              className={
                snap.projectedExtraCostEur > 0
                  ? 'text-over text-lg font-medium'
                  : 'text-lg font-medium'
              }
            >
              {fmtEur(snap.projectedExtraCostEur)}
            </div>
          </div>
        </div>
        {minBilled != null && snap.thresholdKw <= minBilled && (
          <p className="text-muted-foreground text-xs">
            {t('live.minBilledHint', { kw: fmtNumber(minBilled, 0) })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TodayCard({ snap, className }: { snap: LiveSnapshot; className?: string }) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const dayStart = startOfLocalDay(snap.interval.start, TIME_ZONE);
  const { data } = useQuery({
    ...intervalsQuery(dayStart, snap.interval.start),
    refetchInterval: 60_000,
  });

  const option = useMemo(() => {
    const c = chartColors(dark);
    const limit = snap.effectiveLimitKw;
    const color = (kw: number) => (kw > limit ? c.over : kw > limit * 0.9 ? c.warning : c.safe);
    // One category per local quarter-hour (92/96/100 on DST days) keeps bar widths even.
    const slots: number[] = [];
    const dayEnd = startOfLocalDay(dayStart + 26 * 3_600_000, TIME_ZONE);
    for (let ts = dayStart; ts < dayEnd; ts += INTERVAL_MS) slots.push(ts);
    const byStart = new Map((data ?? []).map((i) => [i.start, i]));
    const bars = slots.map((ts) => {
      if (ts === snap.interval.start) {
        const kw = snap.interval.projectedKw;
        return { value: kw, itemStyle: { color: color(kw), opacity: 0.4 } };
      }
      const i = byStart.get(ts);
      const kw = i?.avgImportKw ?? null;
      return {
        value: kw,
        itemStyle: { color: color(kw ?? 0), opacity: i?.quality === 'exact' ? 1 : 0.6 },
      };
    });
    const markLines: object[] = [
      {
        yAxis: limit,
        lineStyle: { color: c.limit, type: 'dashed' },
        label: { formatter: t('live.limit'), color: c.text, position: 'insideEndTop' },
      },
    ];
    if (snap.monthPeak) {
      markLines.push({
        yAxis: snap.monthPeak.kw,
        lineStyle: { color: c.peak, type: 'dashed' },
        label: { formatter: t('live.monthPeak'), color: c.text, position: 'insideEndTop' },
      });
    }
    return {
      // Updated with every live snapshot: animating would restart the grow-in each time.
      animation: false,
      grid: { left: 40, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number | null) => fmtKw(v),
        axisPointer: { type: 'shadow' },
      },
      xAxis: {
        type: 'category',
        data: slots,
        axisLabel: { color: c.text, interval: 15, formatter: (v: string) => fmtTime(Number(v)) },
        axisTick: { alignWithLabel: true, interval: 15 },
        axisLine: { lineStyle: { color: c.axis } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: c.text },
        splitLine: { lineStyle: { color: c.axis } },
        max: (v: { max: number }) => Math.ceil(Math.max(v.max, limit) * 1.1),
      },
      series: [
        {
          type: 'bar',
          barCategoryGap: '20%',
          data: bars,
          markLine: { symbol: 'none', silent: true, data: markLines },
        },
      ],
    };
  }, [
    data,
    snap.interval.start,
    snap.interval.projectedKw,
    snap.effectiveLimitKw,
    snap.monthPeak,
    dark,
    dayStart,
    t,
  ]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t('live.today')}</CardTitle>
      </CardHeader>
      <CardContent>
        <EChart option={option} className="h-56" />
      </CardContent>
    </Card>
  );
}
