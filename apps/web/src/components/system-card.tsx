import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { auditQuery, eventsQuery, healthQuery } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

export function SystemCard() {
  const { t } = useTranslation();
  const health = useQuery(healthQuery);
  const events = useQuery(eventsQuery);
  const audit = useQuery(auditQuery);
  const hb = health.data?.collectorHeartbeatAgeMs;

  return (
    <Card data-testid="system-card">
      <CardHeader>
        <CardTitle>{t('system.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-3 text-sm">
          <span className="flex items-center gap-2">
            {t('system.db')}
            <Badge variant={health.data?.db ? 'safe' : 'over'}>
              {health.data?.db ? t('system.ok') : t('system.down')}
            </Badge>
          </span>
          <span className="flex items-center gap-2">
            {t('system.collector')}
            <Badge variant={hb != null && hb < 60_000 ? 'safe' : 'over'}>
              {hb == null ? t('system.down') : t('system.ago', { s: Math.round(hb / 1000) })}
            </Badge>
          </span>
        </div>
        <section>
          <h3 className="mb-2 text-sm font-medium">{t('system.events')}</h3>
          <List
            rows={(events.data ?? []).map((e) => ({
              id: e.id,
              ts: e.ts,
              tag: e.kind,
              text: e.message,
            }))}
            empty={t('system.none')}
          />
        </section>
        <section>
          <h3 className="mb-2 text-sm font-medium">{t('system.audit')}</h3>
          <List
            rows={(audit.data ?? []).map((a) => ({
              id: a.id,
              ts: a.ts,
              tag: a.actor,
              text: `${a.action}${a.changed.length ? ` – ${t('system.changed')}: ${a.changed.join(', ')}` : ''}`,
            }))}
            empty={t('system.none')}
          />
        </section>
      </CardContent>
    </Card>
  );
}

function List({
  rows,
  empty,
}: {
  rows: { id: number; ts: number; tag: string; text: string }[];
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return (
    <ul className="max-h-64 divide-y overflow-y-auto text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex gap-3 py-1.5">
          <span className="text-muted-foreground w-36 shrink-0 tabular-nums">
            {fmtDateTime(r.ts)}
          </span>
          <Badge variant="secondary" className="shrink-0">
            {r.tag}
          </Badge>
          <span className="min-w-0">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
