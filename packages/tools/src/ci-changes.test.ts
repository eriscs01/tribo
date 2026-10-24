import { describe, expect, it } from 'vitest';

import { affectsCode, isDocsPath } from './ci-changes.js';

describe('isDocsPath', () => {
  it.each([
    'docs/runbook.md',
    'docs/design/technical-design.md',
    'docs/decisions/0013-ci-path-rules.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'packages/db/README.md',
    '.claude/skills/design-principles/SKILL.md',
  ])('%s is documentation', (path) => {
    expect(isDocsPath(path)).toBe(true);
  });

  it.each([
    // backlog.test.ts compares this file with the registry.
    'docs/backlog.md',
    '.github/workflows/ci.yml',
    '.github/pull_request_template.md',
    '.github/scripts/api-breaking.sh',
    'deploy/dev/README.md',
    'deploy/compose.yml',
    'packages/db/migrations/0002_trips.sql',
    'pnpm-lock.yaml',
    'package.json',
    'apps/web/package.json',
    '.nvmrc',
    'vitest.config.ts',
    'eslint.config.js',
    'tsconfig.base.json',
    'knip.jsonc',
    '.squawk.toml',
    '.gitleaks.toml',
    '.dependency-cruiser.cjs',
    'osv-scanner.toml',
    '.trivyignore.yaml',
    'apps/server/src/app.ts',
    'packages/contract/openapi.json',
    // A script or fixture under docs/ is not prose.
    'docs/design/diagram.ts',
    // Unknown files count as code: the rule fails towards running everything.
    'something/new.bin',
  ])('%s counts as code', (path) => {
    expect(isDocsPath(path)).toBe(false);
  });

  it('does not let a path trick its way into the docs', () => {
    expect(isDocsPath('docs/../apps/server/src/app.ts')).toBe(false);
    expect(isDocsPath('apps/server/docs/x.md')).toBe(false);
    expect(isDocsPath('docs/x.md\napps/a.ts')).toBe(false);
  });
});

describe('affectsCode', () => {
  it('is false for an empty change and for documentation only', () => {
    expect(affectsCode([])).toBe(false);
    expect(affectsCode(['docs/runbook.md', 'CLAUDE.md'])).toBe(false);
  });

  it('is true as soon as one path is code', () => {
    expect(affectsCode(['docs/runbook.md', '.github/workflows/ci.yml'])).toBe(true);
  });
});
