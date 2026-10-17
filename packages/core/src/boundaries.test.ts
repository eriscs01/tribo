import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cruise, type IConfiguration, type ICruiseResult } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../../.dependency-cruiser.cjs') as IConfiguration;
const fixtures = fileURLToPath(new URL('../boundary-fixtures/', import.meta.url));

describe('dependency-cruiser boundary rules', () => {
  it('fire on exactly the forbidden imports in boundary-fixtures/', async () => {
    const { output } = await cruise(['apps', 'packages'], {
      ...config.options,
      ruleSet: { forbidden: config.forbidden ?? [] },
      validate: true,
      baseDir: fixtures,
      exclude: { path: '\\.typecheck\\.ts$' },
    });
    const violations = (output as ICruiseResult).summary.violations
      .map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)
      .sort();
    expect(violations).toEqual([
      'core-module-past-service: packages/core/src/trips/reaches-repo.ts -> packages/core/src/items/repo.ts',
      'core-module-past-service: packages/core/src/trips/type-only.ts -> packages/core/src/items/policy.ts',
      'core-reached-past-service: apps/server/src/index.ts -> packages/core/src/items/repo.ts',
      'no-circular: packages/core/src/library/a.ts -> packages/core/src/library/b.ts',
      'packages-never-import-apps: packages/core/src/imports-app.ts -> apps/server/src/index.ts',
      'web-imports-only-contract: apps/web/src/index.ts -> packages/db/src/index.ts',
    ]);
  });
});
