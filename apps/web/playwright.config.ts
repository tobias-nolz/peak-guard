import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against a running stack (default: `docker compose --profile dev up`
 * on http://localhost:8080). Override with E2E_BASE_URL. If the stack uses
 * AUTH_MODE=password, set E2E_AUTH_USER / E2E_AUTH_PASSWORD; the setup project logs in
 * once and all specs reuse the session.
 */
const storageState = 'e2e/.auth/state.json';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], storageState },
      dependencies: ['setup'],
    },
    { name: 'mobile', use: { ...devices['Pixel 7'], storageState }, dependencies: ['setup'] },
  ],
});
