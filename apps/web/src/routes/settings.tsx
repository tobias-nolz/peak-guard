import { useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { settingsSchema, type Settings } from '@peak-guard/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, settingsQuery } from '@/lib/api';
import { SystemCard } from '@/components/system-card';
import { LANGUAGES } from '@/i18n';
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
