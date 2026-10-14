import { defineProject } from 'vitest/config';

/** Resolve workspace packages to their TypeScript sources in tests (see "exports" conditions). */
export const sourceConditions = ['@peak-guard/source'];

export function nodeProject(name: string) {
  return defineProject({
    resolve: { conditions: sourceConditions },
    ssr: { resolve: { conditions: sourceConditions } },
    test: {
      name,
      environment: 'node',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
  });
}
