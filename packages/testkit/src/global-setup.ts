// Vitest globalSetup for the integration and leak projects: one PostgreSQL 18 container per
// run, bootstrapped and migrated once; tests clone per-test databases from it.
import type { TestProject } from 'vitest/node';
import { startPostgres, type PostgresInfo } from './postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    triboPostgres: PostgresInfo;
  }
}

export default async function setup(project: TestProject) {
  const { info, container } = await startPostgres();
  project.provide('triboPostgres', info);
  return async () => {
    await container.stop();
  };
}
