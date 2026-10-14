import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Layout } from '@/components/layout';
import { HistoryPage } from '@/routes/history';
import { LivePage } from '@/routes/live';
import { SettingsPage } from '@/routes/settings';

const rootRoute = createRootRoute({ component: Layout });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: LivePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/history', component: HistoryPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
