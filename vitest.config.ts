import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = '{apps,packages}/*/src/**';
const globalSetup = ['packages/testkit/src/global-setup.ts'];

// Tests normally import workspace packages through their built dist. Under `--coverage` they
// import the TypeScript source instead, so V8 attributes every line a test runs to its src file.
const coverage = process.argv.some((arg) => arg.startsWith('--coverage'));
const sourceAliases = [
  { find: '@tribo/testkit/totp', replacement: resolve('packages/testkit/src/totp.ts') },
  {
    find: /^@tribo\/(contract|core|crypto|db|platform|testkit)$/,
    replacement: resolve('packages/$1/src/index.ts'),
  },
  { find: /^@tribo\/server$/, replacement: resolve('apps/server/src/index.ts') },
];

// unit: no I/O (web tests opt into jsdom per file). integration and leak: one PostgreSQL 18 container per run (Docker needed).
export default defineConfig({
  resolve: { alias: coverage ? sourceAliases : [] },
  test: {
    // Story tests carry their drop (`// @module-tag drop-a`): `vitest run --tags-filter drop-b`.
    tags: [{ name: 'drop-a' }, { name: 'drop-b' }],
    // `pnpm test:coverage`: V8 coverage computed and reported locally; nothing leaves the machine.
    coverage: {
      provider: 'v8',
      include: [`${src}/*.{ts,tsx}`],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.typecheck.ts',
        '**/generated/**',
        '**/scripts/**',
        '**/bin/**',
        'apps/e2e/**',
        'packages/testkit/**',
        // Process entry points: only start-up and signals; the end-to-end test runs them.
        'apps/server/src/main.ts',
        'apps/server/src/cli.ts',
        'apps/web/src/main.tsx',
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // Floors, not targets: raise them when coverage rises, never lower them to merge. A line
      // counts as covered only when a test that asserts its rule runs it (CLAUDE.md, tests).
      thresholds: {
        statements: 93,
        branches: 85,
        functions: 96,
        lines: 95,
        'packages/core/src/**': { statements: 94, branches: 89, functions: 99, lines: 97 },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: [`${src}/*.test.{ts,tsx}`],
          exclude: [`${src}/*.int.test.ts`, `${src}/*.leak.test.ts`],
        },
      },
      {
        test: {
          name: 'integration',
          include: [`${src}/*.int.test.ts`],
          globalSetup,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: 'leak',
          include: [`${src}/*.leak.test.ts`],
          globalSetup,
          testTimeout: 600_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
