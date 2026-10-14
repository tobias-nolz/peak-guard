import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function HistoryPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('history.title')}</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground">{t('history.comingSoon')}</CardContent>
    </Card>
  );
}
