import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { fmtMonth } from '@/lib/format';
import { shiftMonth } from '@/lib/time';

export function MonthPicker({
  month,
  onChange,
  max,
}: {
  month: string;
  onChange: (m: string) => void;
  max?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon"
        aria-label={t('history.prev')}
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-36 text-center font-medium" data-testid="month-label">
        {fmtMonth(month)}
      </span>
      <Button
        variant="outline"
        size="icon"
        aria-label={t('history.next')}
        disabled={max != null && month >= max}
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

export function ExportLinks({ links }: { links: { label: string; href: string }[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t('history.export')}:</span>
      {links.map((l) => (
        <Button key={l.href} variant="outline" size="sm" asChild>
          <a href={l.href} download>
            {l.label}
          </a>
        </Button>
      ))}
    </div>
  );
}
