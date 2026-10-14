import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Layout } from '@/components/layout';
import { ControlPage } from '@/routes/control';
import { HistoryPage, historySearchSchema } from '@/routes/history';
import { LivePage } from '@/routes/live';
import { LoginPage } from '@/routes/login';
import { SettingsPage } from '@/routes/settings';
import { SimulationPage } from '@/routes/simulation';

const rootRoute = createRootRoute({ component: Outlet });

/** Pathless layout route with navigation, live stream and status badges. */
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: Layout });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage }),
  appRoute.addChildren([
    createRoute({ getParentRoute: () => appRoute, path: '/', component: LivePage }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/history',
      component: HistoryPage,
      validateSearch: historySearchSchema,
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/simulation', component: SimulationPage }),
    createRoute({ getParentRoute: () => appRoute, path: '/control', component: ControlPage }),
    createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage }),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
