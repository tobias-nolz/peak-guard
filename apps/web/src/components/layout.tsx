import { Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  FlaskConical,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, meQuery } from '@/lib/api';
import { LiveContext } from '@/lib/live-context';
import { useTheme, type ThemePref } from '@/lib/theme';
import { useLive } from '@/lib/use-live';

const NEXT_THEME: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };

export function Layout() {
  const { t } = useTranslation();
  const live = useLive();
  const { pref, setPref } = useTheme();
  const conn = live.stream === 'error' ? 'stream' : (live.snapshot?.connection ?? 'down');
  const connVariant = conn === 'ok' ? 'safe' : conn === 'stale' ? 'warning' : 'over';
  const ThemeIcon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor;
  const me = useQuery(meQuery);
  const signedOut = me.data != null && me.data.user == null;
  useEffect(() => {
    // The live stream can't report 401 to the page, so gate on /api/auth/me as well.
    if (signedOut) {
      const next = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [signedOut]);

  const nav = [
    { to: '/', label: t('nav.live'), icon: Activity },
    { to: '/history', label: t('nav.history'), icon: BarChart3 },
    { to: '/simulation', label: t('nav.simulation'), icon: FlaskConical },
    { to: '/settings', label: t('nav.settings'), icon: Settings },
  ] as const;

  return (
    <LiveContext.Provider value={live}>
      <div className="min-h-dvh pb-20 md:pb-0">
        <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <img src="/favicon.svg" alt="" className="size-7" />
              {t('app.title')}
            </Link>
            <nav className="ml-4 hidden gap-1 md:flex">
              {nav.map((n) => (
                <Link
                  key={n.to}
                  to={n.to}
                  className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm"
                  activeProps={{ className: 'bg-accent text-foreground!' }}
                  activeOptions={{ exact: n.to === '/' }}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="outline" className="hidden sm:inline-flex">
                {t('mode.monitor')}
              </Badge>
              <Badge variant={connVariant} data-testid="connection">
                <span className="size-1.5 rounded-full bg-current" />
                {t(`connection.${conn}`)}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPref(NEXT_THEME[pref])}
                title={t(`theme.${pref}`)}
                aria-label={t(`theme.${pref}`)}
              >
                <ThemeIcon />
              </Button>
              {me.data?.mode === 'password' && me.data.user && (
                <Button
                  variant="ghost"
                  size="icon"
                  title={`${t('auth.logout')} (${me.data.user})`}
                  aria-label={t('auth.logout')}
                  onClick={() => void api.logout().then(() => window.location.assign('/login'))}
                >
                  <LogOut />
                </Button>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">
          <Outlet />
        </main>
        {/* Mobile bottom navigation */}
        <nav className="bg-background/95 fixed inset-x-0 bottom-0 z-10 flex border-t pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="text-muted-foreground flex flex-1 flex-col items-center gap-0.5 py-2 text-xs"
              activeProps={{ className: 'text-primary!' }}
              activeOptions={{ exact: n.to === '/' }}
            >
              <n.icon className="size-5" />
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
    </LiveContext.Provider>
  );
}
