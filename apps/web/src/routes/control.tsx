import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ControlSettings } from '@peak-guard/shared';
import { EChart, chartColors } from '@/components/echart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, api, controlStatusQuery, type ControlStatusDto } from '@/lib/api';
import { fmtDateTime, fmtEur, fmtKw, fmtNumber, fmtTime, fmtW } from '@/lib/format';
import { useLiveContext } from '@/lib/live-context';
import { useTheme } from '@/lib/theme';
import { monthOf, useNow } from '@/lib/time';

type Mode = ControlSettings['mode'];

export function ControlPage() {
  const { t } = useTranslation();
  const { data } = useQuery(controlStatusQuery);
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t('control.title')}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">{t('control.intro')}</p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ModeCard data={data} />
        <StatusCard data={data} />
        <RevertTestCard data={data} />
        <ParamsCard key={JSON.stringify(data.settings)} initial={data.settings} />
      </div>
      <DecisionsChart />
      <DryRunCard />
      <p className="text-muted-foreground text-xs">{t('control.checklist')}</p>
    </div>
  );
}

function ModeCard({ data }: { data: ControlStatusDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ack, setAck] = useState(data.settings.acknowledgeNoRevert);
  const save = useMutation({
    mutationFn: (mode: Mode) =>
      api.saveControl({ ...data.settings, mode, acknowledgeNoRevert: ack }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['control-status'] }),
  });
  const revertPassed = data.status?.revertTest?.status === 'passed';
  const error = save.error instanceof ApiError ? save.error.message : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('control.mode')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={data.settings.mode} onValueChange={(v) => save.mutate(v as Mode)}>
          <TabsList>
            {(['off', 'dryRun', 'active'] as const).map((m) => (
              <TabsTrigger key={m} value={m} data-testid={`mode-${m}`}>
                {t(`control.modes.${m}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {data.settings.mode === 'active' && <PauseControls data={data} />}
        {!revertPassed && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {t('control.ack')}
          </label>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {t('control.blocked', { reason: error })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StatusCard({ data }: { data: ControlStatusDto }) {
  const { t } = useTranslation();
  const { snapshot } = useLiveContext();
  const s = data.status;
  const st = s?.modbus.storage;
  const c = snapshot?.control;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
  const section = (label: string) => (
    <div className="pt-3 pb-1 text-xs font-medium tracking-wide uppercase">{label}</div>
  );
  const mode = data.settings.mode;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('control.status')}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y text-sm" data-testid="control-status">
        {row(
          t('control.mode'),
          <Badge variant={mode === 'active' ? 'warning' : 'secondary'} data-testid="status-mode">
            {t(`control.modes.${mode}`)}
          </Badge>,
        )}
        {row(
          t('control.writes'),
          <Badge variant={s?.writesEnabled ? 'warning' : 'secondary'}>
            {s?.writesEnabled ? <ShieldAlert /> : <ShieldCheck />}
            {s?.writesEnabled ? t('control.writesOn') : t('control.writesOff')}
          </Badge>,
        )}
        {row(
          t('control.modbus'),
          <Badge
            variant={
              s?.modbus.state === 'ok' ? 'safe' : s?.modbus.state === 'error' ? 'over' : 'secondary'
            }
          >
            {t(`control.modbusStates.${s?.modbus.state ?? 'disabled'}`)}
          </Badge>,
        )}
        {s?.modbus.error && row('', <span className="text-destructive">{s.modbus.error}</span>)}
        {st && (
          <>
            {section(t('control.inverterSection'))}
            {row(t('control.wChaMax'), fmtW(st.wChaMaxW))}
            {row(
              t('control.soc'),
              st.chaStatePct == null ? '–' : `${fmtNumber(st.chaStatePct, 1)} %`,
            )}
            {row(t('control.storCtlMod'), st.storCtlMod)}
            {row(
              t('control.outWRte'),
              st.outWRtePct == null ? '–' : `${fmtNumber(st.outWRtePct, 1)} %`,
            )}
            {row(t('control.revert'), st.rvrtTmsS == null ? '–' : `${st.rvrtTmsS} s`)}
            {row(t('control.chaSt'), st.chaSt ?? '–')}
          </>
        )}
        {section(t('control.decisionSection'))}
        {mode === 'active' &&
          row(
            t('control.applying'),
            <Badge variant={s?.applying ? 'safe' : 'secondary'} data-testid="control-applying">
              {s?.applying ? t('control.applying') : t('control.notApplying')}
            </Badge>,
          )}
        {s?.fault && row(t('control.fault'), <span className="text-destructive">{s.fault}</span>)}
        {s?.pausedUntil && row(t('control.pausedUntil'), fmtDateTime(s.pausedUntil))}
        {row(
          t('control.decision'),
          c?.decision ? (
            <span data-testid="control-decision">{t(`control.decisions.${c.decision}`)}</span>
          ) : (
            '–'
          ),
        )}
        {c?.decision && row(t('control.target'), fmtKw(c.targetKw, 1))}
        {c?.decision &&
          row(
            t('control.limit'),
            <span data-testid="wanted-limit">
              {c.limitW == null ? t('control.noLimit') : fmtW(c.limitW)}
              {mode !== 'active' && (
                <span className="text-muted-foreground block text-xs">
                  {t('control.notWritten', { mode: t(`control.modes.${mode}`) })}
                </span>
              )}
            </span>,
          )}
        {(s?.note ?? c?.note) &&
          row(t('control.note'), <span className="text-warning">{s?.note ?? c?.note}</span>)}
      </CardContent>
    </Card>
  );
}

function RevertTestCard({ data }: { data: ControlStatusDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: api.revertTest,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['control-status'] }),
  });
  const r = data.status?.revertTest;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('control.revertTest')}</CardTitle>
        <CardDescription>{t('control.revertIntro')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => run.mutate()}
            disabled={run.isPending || r?.status === 'running'}
            data-testid="run-revert-test"
          >
            {t('control.runTest')}
          </Button>
          <Badge
            variant={
              r?.status === 'passed' ? 'safe' : r?.status === 'failed' ? 'over' : 'secondary'
            }
            data-testid="revert-status"
          >
            {r ? t(`control.testStates.${r.status}`) : t('control.testNever')}
          </Badge>
        </div>
        {r && (
          <p className="text-muted-foreground">
            {fmtDateTime(r.startedAt)} – {r.message}
          </p>
        )}
        {run.error && (
          <p className="text-destructive" role="alert">
            {run.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ParamsCard({ initial }: { initial: ControlSettings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [p, setP] = useState(initial);
  const save = useMutation({
    mutationFn: api.saveControl,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['control-status'] }),
  });
  const num = (
    key: 'reservePct' | 'marginKw' | 'minUpdateIntervalS' | 'minChangeW' | 'revertTimeoutS',
    label: string,
    step = '1',
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ctl-${key}`}>{label}</Label>
      <Input
        id={`ctl-${key}`}
        type="number"
        step={step}
        value={p[key]}
        onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })}
      />
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('control.params')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {num('reservePct', t('control.reserve'))}
          {num('marginKw', t('control.margin'), '0.1')}
          {num('minUpdateIntervalS', t('control.minUpdate'))}
          {num('minChangeW', t('control.minChange'), '50')}
          {num('revertTimeoutS', t('control.revertS'), '10')}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={p.adaptive}
            onChange={(e) => setP({ ...p, adaptive: e.target.checked })}
          />
          {t('control.adaptive')}
        </label>
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate(p)} disabled={save.isPending}>
            {t('control.save')}
          </Button>
          {save.isSuccess && <span className="text-safe text-sm">{t('control.saved')}</span>}
          {save.isError && (
            <span className="text-destructive text-sm" role="alert">
              {save.error.message}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DecisionsChart() {
  const { t } = useTranslation();
  const { dark } = useTheme();
  const { data } = useQuery({
    queryKey: ['decisions', 'recent'],
    queryFn: () => api.decisions(Date.now() - 2 * 3_600_000, Date.now() + 60_000),
    refetchInterval: 15_000,
  });
  const c = chartColors(dark);
  const rows = data ?? [];
  const option = {
    animation: false,
    legend: { top: 0, textStyle: { color: c.text } },
    grid: { left: 44, right: 16, top: 36, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => fmtKw(v) },
    xAxis: { type: 'time', axisLabel: { color: c.text, formatter: (v: number) => fmtTime(v) } },
    yAxis: {
      type: 'value',
      name: 'kW',
      nameTextStyle: { color: c.text },
      axisLabel: { color: c.text },
      splitLine: { lineStyle: { color: c.axis } },
    },
    series: [
      {
        name: t('control.projected'),
        type: 'line',
        step: 'end',
        showSymbol: false,
        color: c.grid,
        data: rows.map((r) => [r.ts, r.projectedKw]),
      },
      {
        name: t('control.target'),
        type: 'line',
        step: 'end',
        showSymbol: false,
        color: c.limit,
        lineStyle: { type: 'dashed' },
        data: rows.map((r) => [r.ts, r.targetKw]),
      },
      {
        name: t('control.limit'),
        type: 'line',
        step: 'end',
        showSymbol: false,
        color: c.battery,
        areaStyle: { opacity: 0.15 },
        data: rows.map((r) => [r.ts, r.decision === 'shave' ? (r.limitW ?? 0) / 1000 : 0]),
      },
    ],
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('control.chart')}</CardTitle>
      </CardHeader>
      <CardContent>
        <EChart option={option} className="h-64" />
      </CardContent>
    </Card>
  );
}

function DryRunCard() {
  const { t } = useTranslation();
  const now = useNow();
  const { data } = useQuery({
    queryKey: ['dry-run', monthOf(now)],
    queryFn: () => api.dryRunSummary(monthOf(now)),
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const stat = (label: string, value: string, testId?: string) => (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </div>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('control.dryRun')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {stat(t('control.actualPeak'), fmtKw(data.actualPeakKw))}
        {stat(t('control.predictedPeak'), fmtKw(data.predictedPeakKw), 'predicted-peak')}
        {stat(t('control.saving'), fmtEur(data.savingEur))}
        {stat(t('control.shaveIntervals'), String(data.shaveIntervals))}
        {stat(t('control.shaveEnergy'), `${fmtNumber(data.shaveKwh, 1)} kWh`)}
      </CardContent>
    </Card>
  );
}

function PauseControls({ data }: { data: ControlStatusDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const now = useNow();
  const done = () => void qc.invalidateQueries({ queryKey: ['control-status'] });
  const pause = useMutation({ mutationFn: api.pauseControl, onSuccess: done });
  const clear = useMutation({ mutationFn: api.clearFault, onSuccess: done });
  const paused = !!data.status?.pausedUntil && data.status.pausedUntil > now;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {paused ? (
          <Button size="sm" variant="outline" onClick={() => pause.mutate(0)} data-testid="resume">
            {t('control.resume')}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => pause.mutate(30)}
              data-testid="pause-30"
            >
              {t('control.pause30')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => pause.mutate(120)}>
              {t('control.pause120')}
            </Button>
          </>
        )}
        {data.status?.fault && (
          <Button size="sm" variant="destructive" onClick={() => clear.mutate()}>
            {t('control.clearFault')}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">{t('control.pauseHint')}</p>
    </div>
  );
}
