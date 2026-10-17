import { defineConfig } from 'vitest/config';

const src = '{apps,packages}/*/src/**';
const globalSetup = ['packages/testkit/src/global-setup.ts'];

// unit: no I/O. integration and leak: one PostgreSQL 18 container per run (Docker needed).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [`${src}/*.test.ts`],
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
