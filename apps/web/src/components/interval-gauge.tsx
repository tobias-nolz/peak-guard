import { useTranslation } from 'react-i18next';
import type { LiveSnapshot } from '@peak-guard/shared';
import { fmtKw } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATE_BG = { safe: 'bg-safe', warning: 'bg-warning', over: 'bg-over' } as const;

/**
 * Horizontal gauge: committed energy (solid), projection (lighter), with markers for the
 * effective limit and the month-to-date peak.
 */
export function IntervalGauge({ snap }: { snap: LiveSnapshot }) {
  const { t } = useTranslation();
  const { interval, effectiveLimitKw, monthPeak, state } = snap;
  const peakKw = monthPeak?.kw ?? 0;
  const scale = Math.max(effectiveLimitKw, peakKw, interval.projectedKw) * 1.15 || 1;
  const pct = (kw: number) => `${Math.min(100, (kw / scale) * 100)}%`;

  return (
    <div className="space-y-2">
      <div
        className="bg-muted relative h-6 w-full overflow-hidden rounded-md"
        role="meter"
        aria-label={t('live.projected')}
        aria-valuenow={interval.projectedKw}
        aria-valuemax={scale}
      >
        <div
          className={cn('absolute inset-y-0 left-0 opacity-35 transition-[width]', STATE_BG[state])}
          style={{ width: pct(interval.projectedKw) }}
        />
        <div
          className={cn('absolute inset-y-0 left-0 transition-[width]', STATE_BG[state])}
          style={{ width: pct(interval.committedKw) }}
        />
        <Marker at={pct(effectiveLimitKw)} className="bg-amber-500" />
        {monthPeak && <Marker at={pct(peakKw)} className="bg-pink-600 dark:bg-pink-400" />}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Legend
          className="bg-amber-500"
          label={`${t('live.limit')} ${fmtKw(effectiveLimitKw, 1)}`}
        />
        {monthPeak && (
          <Legend
            className="bg-pink-600 dark:bg-pink-400"
            label={`${t('live.monthPeak')} ${fmtKw(peakKw)}`}
          />
        )}
      </div>
    </div>
  );
}

function Marker({ at, className }: { at: string; className: string }) {
  return <div className={cn('absolute inset-y-0 w-0.5', className)} style={{ left: at }} />;
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-block h-3 w-0.5', className)} />
      {label}
    </span>
  );
}
