import { useTranslation } from 'react-i18next';
import type { GridChargeSettings } from '@peak-guard/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Grid-charging parameters (Control page and what-if simulation). */
export function GridChargeFields({
  value: g,
  onChange,
  intro,
  idPrefix = 'gc',
  wide = false,
}: {
  value: GridChargeSettings;
  onChange: (g: GridChargeSettings) => void;
  intro: string;
  idPrefix?: string;
  /** four columns on large screens (full-width card) */
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const field = (
    key: keyof GridChargeSettings,
    label: string,
    input: React.ComponentProps<typeof Input>,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-${key}`}>{label}</Label>
      <Input id={`${idPrefix}-${key}`} disabled={!g.enabled} {...input} />
    </div>
  );
  const num = (
    key: 'hysteresisPct' | 'maxPowerW' | 'minPowerW' | 'headroomKw' | 'cooldownMinutes',
    label: string,
    step = '1',
  ) =>
    field(key, label, {
      type: 'number',
      step,
      value: g[key],
      onChange: (e) => onChange({ ...g, [key]: Number(e.target.value) }),
    });
  const time = (key: 'from' | 'to', label: string) =>
    field(key, label, {
      type: 'time',
      value: g[key],
      onChange: (e) => {
        if (e.target.value) onChange({ ...g, [key]: e.target.value });
      },
    });
  return (
    <fieldset className="space-y-3" data-testid={`${idPrefix}-params`}>
      <legend className="mb-2 text-sm font-semibold">{t('control.gridCharge')}</legend>
      <p className="text-muted-foreground text-xs">{intro}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={g.enabled}
          onChange={(e) => onChange({ ...g, enabled: e.target.checked })}
          data-testid={`${idPrefix}-enabled`}
        />
        {t('control.gcEnabled')}
      </label>
      <div className={cn('grid gap-4 sm:grid-cols-2', wide && 'lg:grid-cols-4')}>
        {num('hysteresisPct', t('control.gcHysteresis'))}
        {num('cooldownMinutes', t('control.gcCooldown'), '5')}
        {num('maxPowerW', t('control.gcMaxPower'), '100')}
        {num('minPowerW', t('control.gcMinPower'), '100')}
        {num('headroomKw', t('control.gcHeadroom'), '0.1')}
        {!wide && <div className="hidden sm:block" />}
        {time('from', t('control.gcFrom'))}
        {time('to', t('control.gcTo'))}
      </div>
    </fieldset>
  );
}
