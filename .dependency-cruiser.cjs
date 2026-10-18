// Boundary rules (CLAUDE.md, "Repo layout"). `pnpm lint` runs them over apps and packages;
// packages/core/src/boundaries.test.ts proves each rule fires on a fixture.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-module-past-service',
      comment:
        'A core module reaches another only through its service.ts; repo, policy and every other file stay private to the module that owns them.',
      severity: 'error',
      from: { path: '^packages/core/(src|dist)/([^/]+)/' },
      to: {
        path: '^packages/core/(src|dist)/[^/]+/',
        pathNot: [
          '^packages/core/(src|dist)/$2/',
          '^packages/core/(src|dist)/[^/]+/service\\.[jt]s$',
        ],
      },
    },
    {
      name: 'core-reached-past-service',
      comment:
        'Outside a module (core index, platform, server, testkit), core is reached through @tribo/core or a service.ts only.',
      severity: 'error',
      from: { pathNot: '^packages/core/(src|dist)/[^/]+/' },
      to: {
        path: '^packages/core/(src|dist)/[^/]+/',
        pathNot: '^packages/core/(src|dist)/[^/]+/service\\.[jt]s$',
      },
    },
    {
      name: 'packages-never-import-apps',
      comment: 'Apps are leaves: no package (core included) imports server or web.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'web-imports-only-contract',
      comment:
        'The SPA talks to the server over HTTP; of the workspace it imports only @tribo/contract.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^(apps|packages)/', pathNot: '^(apps/web|packages/contract)/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    doNotFollow: { path: ['node_modules', '/dist/'] },
    exclude: { path: ['boundary-fixtures', '\\.typecheck\\.ts$'] },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
};
