import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { AnalysisView } from '@/components/history/analysis-view';
import { MonthView } from '@/components/history/month-view';
import { ReconciliationView } from '@/components/history/reconciliation-view';
import { Timeline } from '@/components/history/timeline';
import { YearView } from '@/components/history/year-view';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { monthOf, useNow } from '@/lib/time';

export const historySearchSchema = z.object({
  tab: z.enum(['timeline', 'month', 'analysis', 'year', 'reconciliation']).catch('timeline'),
  range: z.enum(['today', 'week', 'month', 'custom']).catch('today'),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .catch(undefined),
  year: z.number().int().optional().catch(undefined),
});

export function HistoryPage() {
  const { t } = useTranslation();
  // Validated by the route's validateSearch; parsed again here to avoid a circular route type.
  const search = historySearchSchema.parse(useSearch({ strict: false }));
  const navigate = useNavigate();
  const now = useNow();
  const month = search.month ?? monthOf(now);
  const year = search.year ?? Number(month.slice(0, 4));
  const set = (patch: Partial<z.infer<typeof historySearchSchema>>) =>
    void navigate({ to: '/history', search: { ...search, ...patch }, replace: true });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('history.title')}</h1>
      <Tabs value={search.tab} onValueChange={(v) => set({ tab: v as typeof search.tab })}>
        <TabsList className="w-full overflow-x-auto sm:w-fit">
          {(['timeline', 'month', 'analysis', 'year', 'reconciliation'] as const).map((k) => (
            <TabsTrigger key={k} value={k}>
              {t(`history.tabs.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="timeline">
          <Timeline kind={search.range} onKind={(range) => set({ range })} />
        </TabsContent>
        <TabsContent value="month">
          <MonthView month={month} onMonth={(m) => set({ month: m })} />
        </TabsContent>
        <TabsContent value="analysis">
          <AnalysisView month={month} onMonth={(m) => set({ month: m })} />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationView month={month} onMonth={(m) => set({ month: m })} />
        </TabsContent>
        <TabsContent value="year">
          <YearView year={year} onYear={(y) => set({ year: y })} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
