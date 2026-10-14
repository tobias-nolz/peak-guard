import { useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  settingsSchema,
  type FeeWindowSettings,
  type HookAction,
  type LoadShedRuleSettings,
  type Settings,
} from '@peak-guard/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, settingsQuery } from '@/lib/api';
import { SystemCard } from '@/components/system-card';
import { LANGUAGES } from '@/i18n';
import { fmtMonth, weekdayNames } from '@/lib/format';
import { useTheme, type ThemePref } from '@/lib/theme';

export function SettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery(settingsQuery);
  const [saved, setSaved] = useState(false);
  // Lives here, not in the form: the form remounts when the stored settings change.
  const save = useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (s) => {
      qc.setQueryData(settingsQuery.queryKey, s);
      void qc.invalidateQueries({ queryKey: ['audit'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
    },
  });
  if (!data) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
      {/* Remount the form when the stored settings change (saved here or elsewhere). */}
      <SettingsForm key={JSON.stringify(data)} initial={data} save={save} saved={saved} />
      <AppearanceCard />
      <SystemCard />
    </div>
  );
}

function SettingsForm({
  initial,
  save,
  saved,
}: {
  initial: Settings;
  save: UseMutationResult<Settings, Error, Settings>;
  saved: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Settings>(initial);
  const [errors, setErrors] = useState<Set<string>>(new Set());

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = settingsSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(new Set(parsed.error.issues.map((i) => i.path.join('.'))));
      return;
    }
    setErrors(new Set());
    save.mutate(parsed.data);
  };

  const num = (v: string) => (v === '' ? Number.NaN : Number(v));
  const invalid = (path: string) => [...errors].some((e) => e === path || e.startsWith(`${path}.`));
  const tariff = draft.tariffs[0]!;
  const setTariff = (patch: Partial<typeof tariff>) =>
    setDraft({ ...draft, tariffs: [{ ...tariff, ...patch }, ...draft.tariffs.slice(1)] });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <Field
            id="threshold"
            label={t('settings.threshold')}
            help={t('settings.thresholdHelp')}
            invalid={invalid('thresholdKw')}
          >
            <Input
              id="threshold"
              type="number"
              step="0.1"
              min={0}
              value={draft.thresholdKw}
              aria-invalid={invalid('thresholdKw')}
              onChange={(e) => setDraft({ ...draft, thresholdKw: num(e.target.value) })}
            />
          </Field>
          <Field id="warn" label={t('settings.warnRatio')} invalid={invalid('warnRatio')}>
            <Input
              id="warn"
              type="number"
              step="1"
              min={50}
              max={100}
              value={Math.round(draft.warnRatio * 100)}
              aria-invalid={invalid('warnRatio')}
              onChange={(e) => setDraft({ ...draft, warnRatio: num(e.target.value) / 100 })}
            />
          </Field>
          <Field
            id="cal"
            label={t('settings.calibration')}
            help={t('settings.calibrationHelp')}
            invalid={invalid('calibrationFactor')}
          >
            <Input
              id="cal"
              type="number"
              step="0.001"
              value={draft.calibrationFactor}
              aria-invalid={invalid('calibrationFactor')}
              onChange={(e) => setDraft({ ...draft, calibrationFactor: num(e.target.value) })}
            />
          </Field>
          <Field
            id="smooth"
            label={t('settings.smoothing')}
            help={t('settings.smoothingHelp')}
            invalid={invalid('projectionSmoothingS')}
          >
            <Input
              id="smooth"
              type="number"
              step="1"
              min={0}
              max={120}
              value={draft.projectionSmoothingS}
              aria-invalid={invalid('projectionSmoothingS')}
              onChange={(e) => setDraft({ ...draft, projectionSmoothingS: num(e.target.value) })}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.tariffs')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field
              id="tlabel"
              label={t('settings.tariffLabel')}
              invalid={invalid('tariffs.0.label')}
            >
              <Input
                id="tlabel"
                value={tariff.label}
                onChange={(e) => setTariff({ label: e.target.value })}
              />
            </Field>
            <Field
              id="tfrom"
              label={t('settings.validFrom')}
              invalid={invalid('tariffs.0.validFrom')}
            >
              <Input
                id="tfrom"
                type="date"
                value={tariff.validFrom}
                onChange={(e) => setTariff({ validFrom: e.target.value })}
              />
            </Field>
            <Field
              id="tmin"
              label={t('settings.minBilled')}
              invalid={invalid('tariffs.0.minBilledKw')}
            >
              <Input
                id="tmin"
                type="number"
                step="0.1"
                value={tariff.minBilledKw}
                onChange={(e) => setTariff({ minBilledKw: num(e.target.value) })}
              />
            </Field>
          </div>
          <div className="space-y-2">
            <div className="text-muted-foreground grid grid-cols-[1fr_1fr_auto] gap-3 text-xs">
              <span>{t('settings.tierUpTo')}</span>
              <span>{t('settings.tierPrice')}</span>
              <span className="w-9" />
            </div>
            {tariff.tiers.map((tier, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_auto] gap-3">
                <Input
                  type="number"
                  step="0.1"
                  aria-label={t('settings.tierUpTo')}
                  value={tier.upToKw ?? ''}
                  aria-invalid={invalid(`tariffs.0.tiers.${idx}`)}
                  onChange={(e) => {
                    const tiers = [...tariff.tiers];
                    tiers[idx] = {
                      ...tier,
                      upToKw: e.target.value === '' ? null : num(e.target.value),
                    };
                    setTariff({ tiers });
                  }}
                />
                <Input
                  type="number"
                  step="0.01"
                  aria-label={t('settings.tierPrice')}
                  value={tier.eurPerKwYear}
                  aria-invalid={invalid(`tariffs.0.tiers.${idx}`)}
                  onChange={(e) => {
                    const tiers = [...tariff.tiers];
                    tiers[idx] = { ...tier, eurPerKwYear: num(e.target.value) };
                    setTariff({ tiers });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={tariff.tiers.length === 1}
                  onClick={() => setTariff({ tiers: tariff.tiers.filter((_, k) => k !== idx) })}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setTariff({ tiers: [...tariff.tiers, { upToKw: null, eurPerKwYear: 0 }] })
              }
            >
              <Plus /> {t('settings.addTier')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.battery')}</CardTitle>
          <CardDescription>{t('settings.batteryHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-3">
          <Field
            id="bcap"
            label={t('settings.capacity')}
            help={t('settings.unknown')}
            invalid={invalid('battery.capacityKwh')}
          >
            <Input
              id="bcap"
              type="number"
              step="0.01"
              min={0}
              value={draft.battery.capacityKwh ?? ''}
              aria-invalid={invalid('battery.capacityKwh')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  battery: {
                    ...draft.battery,
                    capacityKwh: e.target.value === '' ? null : num(e.target.value),
                  },
                })
              }
            />
          </Field>
          <Field
            id="bpow"
            label={t('settings.maxPower')}
            help={t('settings.unknown')}
            invalid={invalid('battery.maxPowerKw')}
          >
            <Input
              id="bpow"
              type="number"
              step="0.1"
              min={0}
              value={draft.battery.maxPowerKw ?? ''}
              aria-invalid={invalid('battery.maxPowerKw')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  battery: {
                    ...draft.battery,
                    maxPowerKw: e.target.value === '' ? null : num(e.target.value),
                  },
                })
              }
            />
          </Field>
          <Field id="bsoc" label={t('settings.minSoc')} invalid={invalid('battery.minSocPct')}>
            <Input
              id="bsoc"
              type="number"
              step="1"
              min={0}
              max={100}
              value={draft.battery.minSocPct}
              aria-invalid={invalid('battery.minSocPct')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  battery: { ...draft.battery, minSocPct: num(e.target.value) },
                })
              }
            />
          </Field>
        </CardContent>
      </Card>

      <NotificationsCard draft={draft} setDraft={setDraft} />
      <LoadSheddingCard draft={draft} setDraft={setDraft} invalid={invalid} />
      <FeeWindowsCard draft={draft} setDraft={setDraft} invalid={invalid} />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending} data-testid="save-settings">
          {t('settings.save')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(initial);
            setErrors(new Set());
          }}
        >
          {t('settings.reset')}
        </Button>
        {saved && (
          <span className="text-safe text-sm" role="status">
            {t('settings.saved')}
          </span>
        )}
        {errors.size > 0 && (
          <span className="text-destructive text-sm" role="alert">
            {t('settings.invalid')}
          </span>
        )}
        {save.isError && (
          <span className="text-destructive text-sm" role="alert">
            {save.error.message}
          </span>
        )}
      </div>
    </form>
  );
}

function Field(props: {
  id: string;
  label: string;
  help?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id} className={props.invalid ? 'text-destructive' : undefined}>
        {props.label}
      </Label>
      {props.children}
      {props.help && <p className="text-muted-foreground text-xs">{props.help}</p>}
    </div>
  );
}

function AppearanceCard() {
  const { t, i18n } = useTranslation();
  const { pref, setPref } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.appearance')}</CardTitle>
        <CardDescription />
      </CardHeader>
      <CardContent className="flex flex-wrap gap-6">
        <Tabs value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
          <TabsList>
            {(['light', 'dark', 'system'] as const).map((p) => (
              <TabsTrigger key={p} value={p}>
                {t(`theme.${p}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs
          value={i18n.resolvedLanguage ?? 'en'}
          onValueChange={(v) => void i18n.changeLanguage(v)}
          aria-label={t('settings.language')}
        >
          <TabsList>
            {LANGUAGES.map((l) => (
              <TabsTrigger key={l.code} value={l.code}>
                {l.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function NotificationsCard({
  draft,
  setDraft,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  const { t } = useTranslation();
  const channels = useQuery({ queryKey: ['notify-channels'], queryFn: api.notifyChannels });
  const test = useMutation({ mutationFn: api.notifyTest });
  const n = draft.notifications;
  const kinds = [
    'approaching',
    'newPeak',
    'reserveDepleted',
    'connectionLost',
    'controlSafeMode',
  ] as const;
  const list = channels.data?.channels ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('notify.title')}</CardTitle>
        <CardDescription>
          {t('notify.channels')}: {list.length ? list.join(', ') : t('notify.none')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {kinds.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={n.events[k]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    notifications: { ...n, events: { ...n.events, [k]: e.target.checked } },
                  })
                }
              />
              {t(`notify.events.${k}`)}
            </label>
          ))}
        </div>
        <div className="grid items-end gap-4 sm:grid-cols-2">
          <Field id="cooldown" label={t('notify.cooldown')}>
            <Input
              id="cooldown"
              type="number"
              min={0}
              step={5}
              value={n.cooldownMinutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  notifications: { ...n, cooldownMinutes: Number(e.target.value) },
                })
              }
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={!list.length || test.isPending}
              onClick={() => test.mutate()}
            >
              {t('notify.test')}
            </Button>
            {test.isSuccess && <span className="text-safe text-sm">{t('notify.sent')}</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadSheddingCard({
  draft,
  setDraft,
  invalid,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
  invalid: (path: string) => boolean;
}) {
  const { t } = useTranslation();
  const rules = draft.loadShedding;
  const setRule = (idx: number, patch: Partial<LoadShedRuleSettings>) =>
    setDraft({ ...draft, loadShedding: rules.map((r, k) => (k === idx ? { ...r, ...patch } : r)) });
  const add = () =>
    setDraft({
      ...draft,
      loadShedding: [
        ...rules,
        {
          id: Math.random().toString(36).slice(2, 10),
          name: `Hook ${rules.length + 1}`,
          enabled: false,
          triggerRatio: 0.95,
          releaseRatio: 0.8,
          minOnMinutes: 5,
          maxOnMinutes: 60,
          minOffMinutes: 5,
          shed: { type: 'webhook', url: 'http://wallbox.local/api/shed', method: 'POST' },
          restore: { type: 'webhook', url: 'http://wallbox.local/api/restore', method: 'POST' },
        },
      ],
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shed.title')}</CardTitle>
        <CardDescription>{t('shed.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rules.map((r, idx) => (
          <div key={r.id} className="space-y-4 rounded-lg border p-4" data-testid="shed-rule">
            <div className="flex flex-wrap items-end gap-4">
              <Field
                id={`shed-name-${idx}`}
                label={t('shed.name')}
                invalid={invalid(`loadShedding.${idx}.name`)}
              >
                <Input
                  id={`shed-name-${idx}`}
                  value={r.name}
                  onChange={(e) => setRule(idx, { name: e.target.value })}
                />
              </Field>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={r.enabled}
                  onChange={(e) => setRule(idx, { enabled: e.target.checked })}
                />
                {t('shed.enabled')}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() =>
                  setDraft({ ...draft, loadShedding: rules.filter((_, k) => k !== idx) })
                }
              >
                <Trash2 /> {t('shed.remove')}
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-5">
              {(
                [
                  ['triggerRatio', 'shed.trigger', 100],
                  ['releaseRatio', 'shed.release', 100],
                  ['minOnMinutes', 'shed.minOn', 1],
                  ['maxOnMinutes', 'shed.maxOn', 1],
                  ['minOffMinutes', 'shed.minOff', 1],
                ] as const
              ).map(([key, label, factor]) => (
                <Field
                  key={key}
                  id={`shed-${key}-${idx}`}
                  label={t(label)}
                  invalid={invalid(`loadShedding.${idx}.${key}`)}
                >
                  <Input
                    id={`shed-${key}-${idx}`}
                    type="number"
                    value={Math.round(r[key] * factor * 100) / 100}
                    onChange={(e) => setRule(idx, { [key]: Number(e.target.value) / factor })}
                  />
                </Field>
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <ActionEditor
                label={t('shed.shedAction')}
                idPrefix={`shed-a-${idx}`}
                action={r.shed}
                onChange={(shed) => setRule(idx, { shed })}
                invalid={invalid(`loadShedding.${idx}.shed`)}
              />
              <ActionEditor
                label={t('shed.restoreAction')}
                idPrefix={`restore-a-${idx}`}
                action={r.restore}
                onChange={(restore) => setRule(idx, { restore })}
                invalid={invalid(`loadShedding.${idx}.restore`)}
              />
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={rules.length >= 10}
        >
          <Plus /> {t('shed.add')}
        </Button>
      </CardContent>
    </Card>
  );
}

function ActionEditor({
  label,
  idPrefix,
  action,
  onChange,
  invalid,
}: {
  label: string;
  idPrefix: string;
  action: HookAction;
  onChange: (a: HookAction) => void;
  invalid: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className={`space-y-3 rounded-md border p-3 ${invalid ? 'border-destructive' : ''}`}>
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <Tabs
        value={action.type}
        onValueChange={(v) =>
          onChange(
            v === 'webhook'
              ? { type: 'webhook', url: 'http://', method: 'POST' }
              : { type: 'mqtt', topic: '', payload: '', retain: false },
          )
        }
      >
        <TabsList>
          <TabsTrigger value="webhook">Webhook</TabsTrigger>
          <TabsTrigger value="mqtt">MQTT</TabsTrigger>
        </TabsList>
      </Tabs>
      {action.type === 'webhook' ? (
        <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
          <Field id={`${idPrefix}-method`} label={t('shed.method')}>
            <select
              id={`${idPrefix}-method`}
              className="border-input h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={action.method}
              onChange={(e) =>
                onChange({ ...action, method: e.target.value as 'GET' | 'POST' | 'PUT' })
              }
            >
              <option>GET</option>
              <option>POST</option>
              <option>PUT</option>
            </select>
          </Field>
          <Field id={`${idPrefix}-url`} label={t('shed.url')}>
            <Input
              id={`${idPrefix}-url`}
              value={action.url}
              onChange={(e) => onChange({ ...action, url: e.target.value })}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field id={`${idPrefix}-body`} label={t('shed.body')}>
              <Input
                id={`${idPrefix}-body`}
                value={action.body ?? ''}
                onChange={(e) => onChange({ ...action, body: e.target.value || undefined })}
              />
            </Field>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <Field id={`${idPrefix}-topic`} label={t('shed.topic')}>
            <Input
              id={`${idPrefix}-topic`}
              value={action.topic}
              onChange={(e) => onChange({ ...action, topic: e.target.value })}
            />
          </Field>
          <Field id={`${idPrefix}-payload`} label={t('shed.payload')}>
            <Input
              id={`${idPrefix}-payload`}
              value={action.payload}
              onChange={(e) => onChange({ ...action, payload: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={action.retain}
              onChange={(e) => onChange({ ...action, retain: e.target.checked })}
            />
            {t('shed.retain')}
          </label>
        </div>
      )}
    </fieldset>
  );
}

function FeeWindowsCard({
  draft,
  setDraft,
  invalid,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
  invalid: (path: string) => boolean;
}) {
  const { t } = useTranslation();
  const windows = draft.gridFeeWindows;
  const set = (list: FeeWindowSettings[]) => setDraft({ ...draft, gridFeeWindows: list });
  const add = (w: Omit<FeeWindowSettings, 'id'>) =>
    set([...windows, { ...w, id: Math.random().toString(36).slice(2, 10) }]);
  const toggle = (list: number[], v: number) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v].sort((a, b) => a - b);
  const days = weekdayNames();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('fee.title')}</CardTitle>
        <CardDescription>{t('fee.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {windows.map((w, idx) => {
          const patch = (p: Partial<FeeWindowSettings>) =>
            set(windows.map((x, k) => (k === idx ? { ...x, ...p } : x)));
          return (
            <div key={w.id} className="space-y-3 rounded-lg border p-4" data-testid="fee-window">
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_8rem_8rem_auto]">
                <Field
                  id={`fee-label-${idx}`}
                  label={t('fee.label')}
                  invalid={invalid(`gridFeeWindows.${idx}.label`)}
                >
                  <Input
                    id={`fee-label-${idx}`}
                    value={w.label}
                    onChange={(e) => patch({ label: e.target.value })}
                  />
                </Field>
                <Field
                  id={`fee-from-${idx}`}
                  label={t('fee.from')}
                  invalid={invalid(`gridFeeWindows.${idx}.from`)}
                >
                  <Input
                    id={`fee-from-${idx}`}
                    type="time"
                    value={w.from}
                    onChange={(e) => patch({ from: e.target.value })}
                  />
                </Field>
                <Field
                  id={`fee-to-${idx}`}
                  label={t('fee.to')}
                  invalid={invalid(`gridFeeWindows.${idx}.to`)}
                >
                  <Input
                    id={`fee-to-${idx}`}
                    type="time"
                    value={w.to}
                    onChange={(e) => patch({ to: e.target.value })}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => set(windows.filter((_, k) => k !== idx))}
                >
                  <Trash2 /> {t('fee.remove')}
                </Button>
              </div>
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs">{t('fee.months')}</div>
                <div className="flex flex-wrap gap-1">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <Button
                      key={m}
                      type="button"
                      size="sm"
                      variant={w.months.includes(m) ? 'default' : 'outline'}
                      aria-pressed={w.months.includes(m)}
                      onClick={() => patch({ months: toggle(w.months, m) })}
                    >
                      {fmtMonth(`2027-${String(m).padStart(2, '0')}`, 'short').split(' ')[0]}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs">{t('fee.weekdays')}</div>
                <div className="flex flex-wrap gap-1">
                  {days.map((d, i) => (
                    <Button
                      key={d}
                      type="button"
                      size="sm"
                      variant={w.weekdays.includes(i) ? 'default' : 'outline'}
                      aria-pressed={w.weekdays.includes(i)}
                      onClick={() => patch({ weekdays: toggle(w.weekdays, i) })}
                    >
                      {d}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              add({ label: t('fee.add'), months: [], weekdays: [], from: '10:00', to: '16:00' })
            }
          >
            <Plus /> {t('fee.add')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              add({
                label: t('fee.exampleSummer'),
                months: [4, 5, 6, 7, 8, 9],
                weekdays: [],
                from: '10:00',
                to: '16:00',
              })
            }
          >
            {t('fee.exampleSummer')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              add({
                label: t('fee.exampleWinter'),
                months: [10, 11, 12, 1, 2, 3],
                weekdays: [],
                from: '00:00',
                to: '06:00',
              })
            }
          >
            {t('fee.exampleWinter')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
