import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EChart, chartColors } from '@/components/echart';
import { MonthPicker } from '@/components/month-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, batchesQuery, reconciliationQuery, settingsQuery } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtKw, fmtMonth, fmtNumber } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { monthBounds, monthOf, useNow } from '@/lib/time';

type Alignment = 'auto' | 'start' | 'end';

export function ReconciliationView({
  month,
  onMonth,
}: {
  month: string;
  onMonth: (m: string) => void;
}) {
  const { t } = useTranslation();
  const now = useNow();
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <UploadCard />
        <BatchesCard />
      </div>
      <MonthPicker month={month} onChange={onMonth} max={monthOf(now)} />
      <Comparison month={month} />
      <p className="text-muted-foreground text-xs">{t('reconciliation.uploadHint')}</p>
    </div>
  );
}

function UploadCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [alignment, setAlignment] = useState<Alignment>('auto');
  const upload = useMutation({
    mutationFn: (file: File) => api.importCsv(file, alignment),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['reconciliation'] });
      void qc.invalidateQueries({ queryKey: ['month'] });
    },
  });
  const r = upload.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reconciliation.upload')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="csv">{t('reconciliation.file')}</Label>
          <Input id="csv" ref={fileRef} type="file" accept=".csv,text/csv,text/plain" />
        </div>
        <div className="space-y-2">
          <Label>{t('reconciliation.alignment')}</Label>
          <Tabs value={alignment} onValueChange={(v) => setAlignment(v as Alignment)}>
            <TabsList>
              {(['auto', 'start', 'end'] as const).map((a) => (
                <TabsTrigger key={a} value={a}>
                  {t(`reconciliation.alignmentOpt.${a}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <Button
          disabled={upload.isPending}
          onClick={() => {
            const f = fileRef.current?.files?.[0];
            if (f) upload.mutate(f);
          }}
        >
          <Upload /> {upload.isPending ? t('reconciliation.importing') : t('reconciliation.import')}
        </Button>
        {r && (
          <p className="text-safe text-sm" role="status">
            {t('reconciliation.imported', {
              rows: r.rows,
              from: fmtDateTime(r.from),
              to: fmtDateTime(r.to),
              alignment: t(`reconciliation.alignmentOpt.${r.alignment}`),
            })}
            {r.warnings.map((w) => (
              <span key={w} className="text-warning block">
                {w}
              </span>
            ))}
          </p>
        )}
        {upload.isError && (
          <p className="text-destructive text-sm" role="alert">
            {upload.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BatchesCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery(batchesQuery);
  const remove = useMutation({
    mutationFn: api.deleteBatch,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['reconciliation'] });
      void qc.invalidateQueries({ queryKey: ['month'] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reconciliation.batches')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!data?.length ? (
          <p className="text-muted-foreground text-sm">{t('reconciliation.noBatches')}</p>
        ) : (
          <ul className="divide-y text-sm" data-testid="batches">
            {data.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{b.filename}</div>
                  <div className="text-muted-foreground text-xs">
                    {fmtDate(b.from, { day: '2-digit', month: '2-digit', year: 'numeric' })} –{' '}
                    {fmtDate(b.to - 1, { day: '2-digit', month: '2-digit', year: 'numeric' })} ·{' '}
                    {b.rowCount} {t('reconciliation.rows')}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('reconciliation.delete')}
                  onClick={() => remove.mutate(b.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Comparison({ month }: { month: string }) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const qc = useQueryClient();
  const { from, to } = monthBounds(month);
  const { data } = useQuery(reconciliationQuery(from, to));
  const settings = useQuery(settingsQuery);
  const apply = useMutation({
    mutationFn: (f: number) => api.saveSettings({ ...settings.data!, calibrationFactor: f }),
    onSuccess: (s) => qc.setQueryData(settingsQuery.queryKey, s),
  });

  const scatter = useMemo(() => {
    const c = chartColors(dark);
    const max = Math.max(1, ...(data?.points ?? []).flatMap((p) => [p[1], p[2]]));
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 16, bottom: 44 },
      tooltip: {
        formatter: (p: { value: [number, number, number] }) =>
          `${fmtDateTime(p.value[2])}<br/>${t('reconciliation.own')}: ${fmtKw(p.value[0])}<br/>${t('reconciliation.officialAxis')}: ${fmtKw(p.value[1])}`,
      },
      xAxis: {
        type: 'value',
        name: t('reconciliation.own'),
        nameLocation: 'middle',
        nameGap: 28,
        max,
        axisLabel: { color: c.text },
        nameTextStyle: { color: c.text },
        splitLine: { lineStyle: { color: c.axis } },
      },
      yAxis: {
        type: 'value',
        name: t('reconciliation.officialAxis'),
        max,
        axisLabel: { color: c.text },
        nameTextStyle: { color: c.text },
        splitLine: { lineStyle: { color: c.axis } },
      },
      series: [
        {
          type: 'scatter',
          symbolSize: 4,
          color: c.house,
          large: true,
          data: (data?.points ?? []).map((p) => [p[1], p[2], p[0]]),
          markLine: {
            symbol: 'none',
            silent: true,
            lineStyle: { color: c.limit, type: 'dashed' },
            data: [[{ coord: [0, 0] }, { coord: [max, max] }]],
          },
        },
      ],
    };
  }, [data, dark, t]);

  if (!data) return null;
  if (data.n === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center">{t('reconciliation.noOverlap')}</p>
    );
  }
  const f = data.suggestedFactor;
  const cur = settings.data?.calibrationFactor ?? 1;
  const canApply = f != null && f >= 0.8 && f <= 1.2 && Math.abs(f - cur) > 0.0005;

  return (
    <div className="space-y-4" data-testid="reconciliation">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat
          label={t('reconciliation.pairs')}
          value={String(data.n)}
          sub={
            data.officialOnly
              ? t('reconciliation.officialOnly', { n: data.officialOnly })
              : undefined
          }
        />
        <Stat
          label={`${t('reconciliation.officialKwh')} / ${t('reconciliation.ownKwh')}`}
          value={`${fmtNumber(data.officialKwh, 1)} / ${fmtNumber(data.ownKwh, 1)} kWh`}
          sub={
            data.ratio == null
              ? undefined
              : `${t('reconciliation.ratio')} ${fmtNumber(data.ratio, 4)}`
          }
        />
        <Stat
          label={t('reconciliation.meanDelta')}
          value={fmtKw(data.meanAbsDeltaKw, 3)}
          sub={
            data.maxDelta
              ? `${t('reconciliation.maxDelta')}: ${fmtKw(data.maxDelta.officialKw - data.maxDelta.ownKw, 2)}`
              : undefined
          }
        />
        <Card className="gap-1 py-4">
          <CardContent className="space-y-1">
            <div className="text-muted-foreground text-xs">{t('reconciliation.suggested')}</div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tabular-nums" data-testid="suggested-factor">
                {f == null ? '–' : fmtNumber(f, 4)}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!canApply || apply.isPending}
                onClick={() => f != null && apply.mutate(Math.round(f * 10_000) / 10_000)}
              >
                {t('reconciliation.apply')}
              </Button>
            </div>
            <div className="text-muted-foreground text-xs">
              {apply.isSuccess
                ? t('reconciliation.applied', { f: fmtNumber(cur, 4) })
                : t('reconciliation.current', { f: fmtNumber(cur, 4) })}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('reconciliation.scatter')}</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart option={scatter} className="h-72" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('reconciliation.peaks')}</CardTitle>
            <CardDescription />
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr className="border-b">
                  <th className="py-2" />
                  <th className="py-2 text-right">{t('reconciliation.ownPeak')}</th>
                  <th className="py-2 text-right">{t('reconciliation.officialPeak')}</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.month} className="border-b last:border-0">
                    <td className="py-2">{fmtMonth(m.month)}</td>
                    <td className="py-2 text-right tabular-nums">{fmtKw(m.ownPeakKw)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {fmtKw(m.officialPeakKw)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent>
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
      </CardContent>
    </Card>
  );
}
