import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EChartsCoreOption } from 'echarts/core';
import { EChart, chartColors } from '@/components/echart';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type SimulationRequestDto, type SimulationResultDto } from '@/lib/api';
import { fmtEur, fmtKw, fmtMonth, fmtNumber } from '@/lib/format';
import { useTheme } from '@/lib/theme';
import { monthBounds, monthOf, shiftMonth, useNow } from '@/lib/time';

const PERIODS = [1, 3, 6, 12] as const;

const parseList = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => Number(x.replace(',', '.')))
    .filter((x) => Number.isFinite(x));

interface Form {
  months: (typeof PERIODS)[number];
  capacityKwh: string;
  maxPowerKw: string;
  efficiencyPct: string;
  minSocPct: string;
  initialSocPct: string;
  thresholdKw: string;
  reservePct: string;
  adaptive: boolean;
  marginKw: string;
  thresholds: string;
  reserves: string;
  capacities: string;
}

export function SimulationPage() {
  const { t } = useTranslation();
  const defaults = useQuery({ queryKey: ['sim-defaults'], queryFn: api.simulationDefaults });
  if (!defaults.data) return null;
  const d = defaults.data;
  const th = Math.max(10, Math.round(d.thresholdKw));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('sim.title')}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">{t('sim.intro')}</p>
      </div>
      <SimulationForm
        initial={{
          months: 3,
          capacityKwh: String(d.capacityKwh),
          maxPowerKw: String(d.maxPowerKw),
          efficiencyPct: '95',
          minSocPct: String(d.minSocPct),
          initialSocPct: '50',
          thresholdKw: String(th),
          reservePct: '40',
          adaptive: true,
          marginKw: '0.2',
          thresholds: [th, th + 1, th + 2, th + 3].join(', '),
          reserves: '20, 40, 60, 80',
          capacities: String(d.capacityKwh),
        }}
      />
    </div>
  );
}

function SimulationForm({ initial }: { initial: Form }) {
  const { t } = useTranslation();
  const now = useNow();
  const [f, setF] = useState<Form>(initial);
  const set = (patch: Partial<Form>) => setF((cur) => ({ ...cur, ...patch }));
  const sim = useMutation({ mutationFn: api.simulate });

  const request = (form: Form): SimulationRequestDto => {
    const end = monthOf(now);
    return {
      from: monthBounds(shiftMonth(end, -(form.months - 1))).from,
      to: now,
      battery: {
        capacityKwh: Number(form.capacityKwh),
        maxPowerKw: Number(form.maxPowerKw),
        efficiency: Number(form.efficiencyPct) / 100,
        minSocPct: Number(form.minSocPct),
        initialSocPct: Number(form.initialSocPct),
      },
      control: {
        thresholdKw: Number(form.thresholdKw),
        reservePct: Number(form.reservePct),
        adaptive: form.adaptive,
        marginKw: Number(form.marginKw),
      },
      sweep: {
        thresholdsKw: parseList(form.thresholds).slice(0, 8),
        reservesPct: parseList(form.reserves).slice(0, 8),
        capacitiesKwh: parseList(form.capacities).slice(0, 4),
      },
    };
  };
  const run = (form = f) => sim.mutate(request(form));

  const num = (key: keyof Form, label: string, step = '0.1') => (
    <div className="space-y-1.5">
      <Label htmlFor={`sim-${key}`}>{label}</Label>
      <Input
        id={`sim-${key}`}
        type="number"
        step={step}
        value={f[key] as string}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </div>
  );

  return (
    <>
      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-1.5">
            <Label>{t('sim.period')}</Label>
            <Tabs
              value={String(f.months)}
              onValueChange={(v) => set({ months: Number(v) as Form['months'] })}
            >
              <TabsList>
                {PERIODS.map((n) => (
                  <TabsTrigger key={n} value={String(n)}>
                    {n === 1 ? t('sim.lastMonth') : t('sim.months', { n })}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <fieldset className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <legend className="mb-2 text-sm font-semibold">{t('sim.battery')}</legend>
            {num('capacityKwh', t('sim.capacity'))}
            {num('maxPowerKw', t('sim.maxPower'))}
            {num('efficiencyPct', t('sim.efficiency'), '1')}
            {num('minSocPct', t('sim.minSoc'), '1')}
            {num('initialSocPct', t('sim.initialSoc'), '1')}
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold">{t('sim.control')}</legend>
            {num('thresholdKw', t('sim.threshold'))}
            {num('reservePct', t('sim.reserve'), '1')}
            {num('marginKw', t('sim.margin'))}
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <input
                type="checkbox"
                className="size-4"
                checked={f.adaptive}
                onChange={(e) => set({ adaptive: e.target.checked })}
              />
              {t('sim.adaptive')}
            </label>
          </fieldset>
          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold">{t('sim.sweep')}</legend>
            <div className="space-y-1.5">
              <Label htmlFor="sim-thresholds">{t('sim.thresholds')}</Label>
              <Input
                id="sim-thresholds"
                value={f.thresholds}
                onChange={(e) => set({ thresholds: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-reserves">{t('sim.reserves')}</Label>
              <Input
                id="sim-reserves"
                value={f.reserves}
                onChange={(e) => set({ reserves: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-capacities">{t('sim.capacities')}</Label>
              <Input
                id="sim-capacities"
                value={f.capacities}
                onChange={(e) => set({ capacities: e.target.value })}
              />
            </div>
          </fieldset>
          <div className="flex items-center gap-3">
            <Button onClick={() => run()} disabled={sim.isPending} data-testid="run-simulation">
              <Play /> {sim.isPending ? t('sim.running') : t('sim.run')}
            </Button>
            {sim.isError && (
              <span className="text-destructive text-sm" role="alert">
                {/not enough data/.test(sim.error.message) ? t('sim.noData') : sim.error.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
      {sim.data && (
        <Results
          r={sim.data}
          onPick={(thresholdKw, reservePct) => {
            const next = { ...f, thresholdKw: String(thresholdKw), reservePct: String(reservePct) };
            setF(next);
            run(next);
          }}
        />
      )}
    </>
  );
}

function Results({
  r,
  onPick,
}: {
  r: SimulationResultDto;
  onPick: (thresholdKw: number, reservePct: number) => void;
}) {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const capacities = [...new Set((r.sweep ?? []).map((s) => s.capacityKwh))];
  const [capacity, setCapacity] = useState<number | null>(null);
  const cap = capacity ?? capacities[0] ?? null;
  const measuredPeak = Math.max(0, ...r.actual.map((a) => a.peakKw));
  const saving = r.selfConsumption.avgMonthlyCostEur - r.scenario.avgMonthlyCostEur;

  const monthly = (() => {
    const c = chartColors(dark);
    const months = r.scenario.months.map((m) => m.month);
    const by = (list: { month: string; peakKw: number }[]) =>
      months.map((m) => list.find((x) => x.month === m)?.peakKw ?? null);
    const bar = (name: string, color: string, data: (number | null)[]) => ({
      name,
      type: 'bar',
      color,
      data,
    });
    return {
      animation: false,
      legend: { top: 0, textStyle: { color: c.text } },
      grid: { left: 44, right: 16, top: 40, bottom: 28 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => fmtKw(v) },
      xAxis: {
        type: 'category',
        data: months.map((m) => fmtMonth(m, 'short')),
        axisLabel: { color: c.text },
      },
      yAxis: {
        type: 'value',
        name: 'kW',
        nameTextStyle: { color: c.text },
        axisLabel: { color: c.text },
        splitLine: { lineStyle: { color: c.axis } },
      },
      series: [
        bar(t('sim.measured'), c.grid, by(r.actual)),
        bar(t('sim.noBattery'), dark ? '#475569' : '#cbd5e1', by(r.none.months)),
        bar(t('sim.selfConsumption'), c.house, by(r.selfConsumption.months)),
        bar(t('sim.shaving'), c.safe, by(r.scenario.months)),
      ],
    };
  })();

  const heat = (() => {
    const c = chartColors(dark);
    const rows = (r.sweep ?? []).filter((s) => s.capacityKwh === cap);
    const ths = [...new Set(rows.map((s) => s.thresholdKw))].sort((a, b) => a - b);
    const res = [...new Set(rows.map((s) => s.reservePct))].sort((a, b) => a - b);
    const values = rows.map((s) => s.avgMonthlySavingEur);
    return {
      option: {
        animation: false,
        grid: { left: 56, right: 16, top: 8, bottom: 80 },
        tooltip: {
          formatter: (p: { value: [number, number, number] }) =>
            `${ths[p.value[0]]} kW · ${res[p.value[1]]} %<br/>${t('sim.perMonth', { eur: fmtEur(p.value[2]) })}`,
        },
        xAxis: {
          type: 'category',
          name: 'kW',
          nameLocation: 'middle',
          nameGap: 26,
          data: ths.map(String),
          axisLabel: { color: c.text },
          nameTextStyle: { color: c.text },
        },
        yAxis: {
          type: 'category',
          name: '%',
          data: res.map(String),
          axisLabel: { color: c.text },
          nameTextStyle: { color: c.text },
        },
        visualMap: {
          min: Math.min(0, ...values),
          max: Math.max(1, ...values),
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          itemHeight: 200,
          textStyle: { color: c.text },
          inRange: { color: dark ? ['#1e293b', '#15803d'] : ['#f1f5f9', '#4ade80'] },
        },
        series: [
          {
            type: 'heatmap',
            label: {
              show: true,
              color: dark ? '#f8fafc' : '#0f172a',
              fontWeight: 600,
              formatter: (p: { value: [number, number, number] }) => fmtNumber(p.value[2], 2),
            },
            data: rows.map((s) => [
              ths.indexOf(s.thresholdKw),
              res.indexOf(s.reservePct),
              Math.round(s.avgMonthlySavingEur * 100) / 100,
            ]),
          },
        ],
      },
      ths,
      res,
    };
  })();

  const fidelity = r.selfConsumption.peakKw > 0 && measuredPeak > 0;

  return (
    <div className="space-y-4" data-testid="simulation-results">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label={`${t('sim.avgPeak')} · ${t('sim.measured')}`} value={fmtKw(measuredPeak)} />
        <Kpi
          label={`${t('sim.avgPeak')} · ${t('sim.selfConsumption')}`}
          value={fmtKw(r.selfConsumption.peakKw)}
        />
        <Kpi
          label={`${t('sim.avgPeak')} · ${t('sim.shaving')}`}
          value={fmtKw(r.scenario.peakKw)}
          testId="sim-peak"
        />
        <Kpi
          label={t('sim.saving')}
          value={t('sim.perMonth', { eur: fmtEur(saving) })}
          sub={`${t('sim.shaveEnergy')}: ${fmtNumber(r.scenario.shaveKwh, 1)} kWh · ${t('sim.overTarget')}: ${r.scenario.overTarget}`}
        />
      </div>
      {r.best && (
        <p
          className="bg-safe/10 text-safe rounded-lg px-4 py-3 text-sm font-medium"
          data-testid="sim-best"
        >
          {t('sim.best', {
            t: fmtNumber(r.best.thresholdKw, 1),
            r: fmtNumber(r.best.reservePct, 0),
            eur: fmtEur(r.best.avgMonthlySavingEur),
          })}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t('sim.monthly')}</CardTitle>
          {fidelity && (
            <CardDescription>
              {t('sim.fidelity', {
                sim: fmtKw(r.selfConsumption.peakKw),
                real: fmtKw(measuredPeak),
              })}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <EChart option={monthly} className="h-72" />
        </CardContent>
      </Card>
      {r.sweep && r.sweep.length > 0 && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>{t('sim.heatmap')}</CardTitle>
              <CardDescription>{t('sim.heatmapHint')}</CardDescription>
            </div>
            {capacities.length > 1 && (
              <Tabs value={String(cap)} onValueChange={(v) => setCapacity(Number(v))}>
                <TabsList>
                  {capacities.map((c) => (
                    <TabsTrigger key={c} value={String(c)}>
                      {fmtNumber(c, 1)} kWh
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}
          </CardHeader>
          <CardContent>
            <HeatmapChart
              option={heat.option}
              onPick={(x, y) => onPick(heat.ths[x]!, heat.res[y]!)}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Heatmap whose cells pick a threshold/reserve combination. */
function HeatmapChart({
  option,
  onPick,
}: {
  option: EChartsCoreOption;
  onPick: (x: number, y: number) => void;
}) {
  return (
    <EChart
      option={option}
      className="h-80"
      onEvents={{
        click: (p) => {
          const v = (p as { value?: [number, number, number] }).value;
          if (v) onPick(v[0], v[1]);
        },
      }}
    />
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
  sub?: string;
  testId?: string;
}) {
  return (
    <Card className="gap-1 py-4">
      <CardContent>
        <div className="text-muted-foreground text-xs">{label}</div>
        <div className="text-xl font-semibold tabular-nums" data-testid={testId}>
          {value}
        </div>
        {sub && <div className="text-muted-foreground text-xs">{sub}</div>}
      </CardContent>
    </Card>
  );
}
