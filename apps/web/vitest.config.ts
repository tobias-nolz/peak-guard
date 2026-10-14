import { defineProject } from 'vitest/config';

// Unit tests only; Playwright specs in e2e/ are run by `pnpm e2e`.
export default defineProject({
  resolve: { conditions: ['@peak-guard/source'] },
  test: { name: 'web', include: ['src/**/*.test.{ts,tsx}'], passWithNoTests: true },
});
