import { Battery, Home, Sun, UtilityPole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LiveSnapshot } from '@peak-guard/shared';
import { fmtNumber, fmtW } from '@/lib/format';
import { cn } from '@/lib/utils';

type Power = LiveSnapshot['power'];

const THRESHOLD_W = 20;

/**
 * Power-flow diagram: PV (top), grid (left), house (right), battery (bottom), with the
 * inverter in the middle. Animated lines show the direction of each flow.
 */
export function PowerFlow({ power }: { power: Power }) {
  const { t } = useTranslation();
  const grid = power.gridW;
  const pv = power.pvW ?? 0;
  const bat = power.batteryW ?? 0;
  const load = power.loadW ?? 0;

  // Line from node to hub; `dir` 1 = node → hub, −1 = hub → node, 0 = idle.
  const lines = [
    { key: 'pv', d: 'M160 62 L160 128', dir: pv > THRESHOLD_W ? 1 : 0, color: 'stroke-pv' },
    {
      key: 'grid',
      d: 'M62 160 L128 160',
      dir: grid > THRESHOLD_W ? 1 : grid < -THRESHOLD_W ? -1 : 0,
      color: 'stroke-grid',
    },
    {
      key: 'house',
      d: 'M192 160 L258 160',
      dir: load > THRESHOLD_W ? -1 : 0,
      color: 'stroke-house',
    },
    {
      key: 'battery',
      d: 'M160 192 L160 258',
      dir: bat > THRESHOLD_W ? -1 : bat < -THRESHOLD_W ? 1 : 0,
      color: 'stroke-battery',
    },
  ];

  return (
    <div className="relative mx-auto aspect-square w-full max-w-sm">
      <svg viewBox="0 0 320 320" className="absolute inset-0 h-full w-full" aria-hidden>
        {lines.map((l) => (
          <g key={l.key}>
            <path
              d={l.d}
              className="stroke-border"
              strokeWidth={4}
              fill="none"
              strokeLinecap="round"
            />
            {l.dir !== 0 && (
              <path
                d={l.d}
                className={cn('flow-line', l.color)}
                strokeWidth={4}
                fill="none"
                strokeLinecap="round"
                style={{ animationDirection: l.dir === 1 ? 'normal' : 'reverse' }}
              />
            )}
          </g>
        ))}
        <circle cx={160} cy={160} r={30} className="fill-card stroke-border" strokeWidth={3} />
      </svg>

      <Node
        className="top-0 left-1/2 -translate-x-1/2"
        icon={<Sun />}
        tone="text-pv"
        label={t('live.pv')}
        value={fmtW(pv)}
      />
      <Node
        className="top-1/2 left-0 -translate-y-1/2"
        icon={<UtilityPole />}
        tone={grid > 0 ? 'text-foreground' : 'text-safe'}
        label={t('live.grid')}
        value={fmtW(Math.abs(grid))}
        sub={
          grid > THRESHOLD_W ? t('live.import') : grid < -THRESHOLD_W ? t('live.export') : undefined
        }
      />
      <Node
        className="top-1/2 right-0 -translate-y-1/2"
        icon={<Home />}
        tone="text-house"
        label={t('live.house')}
        value={fmtW(load)}
      />
      <Node
        className="bottom-0 left-1/2 -translate-x-1/2"
        icon={<Battery />}
        tone="text-battery"
        label={`${t('live.battery')}${power.socPct != null ? ` · ${fmtNumber(power.socPct, 0)} %` : ''}`}
        value={power.batteryW == null ? '–' : fmtW(Math.abs(bat))}
        sub={
          bat > THRESHOLD_W
            ? t('live.discharging')
            : bat < -THRESHOLD_W
              ? t('live.charging')
              : undefined
        }
        soc={power.socPct}
      />
    </div>
  );
}

function Node(props: {
  className: string;
  icon: React.ReactNode;
  tone: string;
  label: string;
  value: string;
  sub?: string | undefined;
  soc?: number | null;
}) {
  return (
    <div
      className={cn(
        'absolute flex w-28 flex-col items-center gap-0.5 text-center',
        props.className,
      )}
    >
      <div
        className={cn(
          'bg-card flex size-12 items-center justify-center rounded-full border-2 [&_svg]:size-6',
          props.tone,
        )}
      >
        {props.icon}
      </div>
      <div className="text-muted-foreground text-xs">{props.label}</div>
      <div className="text-sm font-semibold tabular-nums">{props.value}</div>
      {props.sub && (
        <div className="text-muted-foreground text-[11px] leading-none">{props.sub}</div>
      )}
      {props.soc != null && (
        <div
          className="bg-muted mt-1 h-1.5 w-16 overflow-hidden rounded-full"
          role="meter"
          aria-valuenow={props.soc}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="bg-battery h-full"
            style={{ width: `${Math.min(100, Math.max(0, props.soc))}%` }}
          />
        </div>
      )}
    </div>
  );
}
