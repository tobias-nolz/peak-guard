import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EChart, chartColors } from '@/components/echart';
import { ExportLinks, MonthPicker } from '@/components/month-picker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { exportUrl, monthQuery, settingsQuery, type TopPeakDto } from '@/lib/api';
import { fmtDateTime, fmtEur, fmtKw, fmtNumber } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { monthBounds, monthOf, useNow } from '@/lib/time';

export function MonthView({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const { data } = useQuery(monthQuery(month));
  const now = useNow();
  const settings = useQuery(settingsQuery);
  const limit = Math.max(
    settings.data?.thresholdKw ?? 0,
    settings.data?.tariffs[0]?.minBilledKw ?? 0,
  );
  const { from, to } = monthBounds(month);

  const dailyOption = useMemo(() => {
    const c = chartColors(dark);
    const days = data?.daily ?? [];
    return {
      animation: false,
      grid: { left: 40, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => fmtKw(v) },
      xAxis: {
        type: 'category',
        data: days.map((d) => d.day.slice(8)),
        axisLabel: { color: c.text },
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
          data: days.map((d) => ({
            value: d.peakKw,
            itemStyle: {
              color:
                (d.peakKw ?? 0) > limit
                  ? c.over
                  : (d.peakKw ?? 0) > limit * 0.9
                    ? c.warning
                    : c.safe,
            },
          })),
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
      ],
    };
  }, [data, dark, limit, t]);

  const total = data?.intervalCount ?? 0;
  const exact = data?.quality.exact ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MonthPicker month={month} onChange={onMonth} max={monthOf(now)} />
        <ExportLinks
          links={[
            { label: 'CSV', href: exportUrl.intervals(from, to, 'csv') },
            { label: 'JSON', href: exportUrl.intervals(from, to, 'json') },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi
          label={t('history.peak')}
          value={fmtKw(data?.peak?.kw ?? null)}
          sub={data?.peak ? t('history.peakAt', { when: fmtDateTime(data.peak.start) }) : undefined}
          testId="month-peak"
        />
        <Kpi label={t('history.billed')} value={fmtKw(data?.billedKw ?? null, 1)} />
        <Kpi label={t('history.cost')} value={fmtEur(data?.costEur ?? null)} />
        <Kpi
          label={t('history.coverage')}
          value={total ? `${fmtNumber((exact / total) * 100, 1)} %` : '–'}
          sub={`${total} ${t('history.intervals')}`}
        />
      </div>

      {total === 0 ? (
        <p className="text-muted-foreground py-12 text-center">{t('history.noData')}</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('history.dailyPeaks')}</CardTitle>
            </CardHeader>
            <CardContent>
              <EChart option={dailyOption} className="h-56" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('history.topPeaks')}</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <TopTable rows={data?.top ?? []} limit={limit} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  testId?: string;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent>
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-2xl font-semibold tabular-nums" data-testid={testId}>
          {value}
        </div>
        {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function TopTable({ rows, limit }: { rows: TopPeakDto[]; limit: number }) {
  const { t } = useTranslation();
  const kw = (v: number | null | undefined) => (v == null ? '–' : fmtNumber(v, 1));
  return (
    <table className="w-full min-w-[640px] text-sm" data-testid="top-peaks">
      <thead className="text-muted-foreground text-left text-xs">
        <tr className="border-b">
          <th className="py-2 pr-2">{t('history.col.rank')}</th>
          <th className="py-2 pr-2">{t('history.col.time')}</th>
          <th className="py-2 pr-2 text-right">{t('history.col.avg')}</th>
          <th className="py-2 pr-2 text-right">{t('history.col.max')}</th>
          <th className="py-2 pr-2">{t('history.col.cause')}</th>
          <th className="py-2 pr-2">{t('history.col.flows')}</th>
          <th className="py-2">{t('history.col.quality')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.start} className="border-b last:border-0">
            <td className="py-2 pr-2 tabular-nums">{i + 1}</td>
            <td className="py-2 pr-2 whitespace-nowrap">{fmtDateTime(r.start)}</td>
            <td
              className={`py-2 pr-2 text-right font-medium whitespace-nowrap tabular-nums ${r.kw > limit ? 'text-over' : ''}`}
            >
              {fmtKw(r.kw)}
            </td>
            <td className="py-2 pr-2 text-right whitespace-nowrap tabular-nums">
              {fmtKw(r.maxImportKw, 1)}
            </td>
            <td className="py-2 pr-2">
              <div className="flex flex-wrap gap-1">
                {r.causes.map((c) => (
                  <Badge key={c} variant="secondary">
                    {t(`cause.${c}`)}
                  </Badge>
                ))}
              </div>
            </td>
            <td className="text-muted-foreground py-2 pr-2 whitespace-nowrap tabular-nums">
              {r.flows
                ? `${kw(r.flows.avgLoadKw)} · ${kw(r.flows.avgPvKw)} · ${kw(r.flows.avgBatteryKw)} kW · ${r.flows.socEnd == null ? '–' : `${fmtNumber(r.flows.socEnd, 0)} %`}`
                : '–'}
            </td>
            <td className="py-2">{t(`quality.${r.quality}`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
