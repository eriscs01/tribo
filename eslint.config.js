import { readdirSync } from 'node:fs';
import path from 'node:path';

import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import { configs, helpers, plugins } from 'eslint-config-airbnb-extended';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Shared dev tooling (vitest, typescript) is declared once at the root, so each workspace
// package checks its imports against its own package.json plus the root one.
const workspaceDirs = ['apps', 'packages'].flatMap((group) =>
  readdirSync(path.join(import.meta.dirname, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${group}/${entry.name}`),
);

/**
 * Airbnb resolves TypeScript imports for .ts files only (its React config adds .tsx); the SPA
 * gets the same resolver with .tsx added, so its imports are checked like everyone else's.
 */
const tsResolution = configs.base.typescript.find(
  (config) => config.settings?.['import-x/resolver-next'] !== undefined,
)?.settings;
/**
 * eslint-plugin-react 7.37.5 and eslint-plugin-jsx-a11y 6.10.2 still call the context methods
 * ESLint 10 removed (getFilename, getSourceCode, …); @eslint/compat restores them per rule.
 */
const fixedUp = (pluginConfig) => ({
  ...pluginConfig,
  plugins: Object.fromEntries(
    Object.entries(pluginConfig.plugins).map(([name, plugin]) => [name, fixupPluginRules(plugin)]),
  ),
});

const tsxResolution = tsResolution && {
  ...tsResolution,
  'import-x/extensions': [...tsResolution['import-x/extensions'], '.tsx'],
  'import-x/parsers': {
    '@typescript-eslint/parser': [
      ...tsResolution['import-x/parsers']['@typescript-eslint/parser'],
      '.tsx',
    ],
  },
};

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      '**/boundary-fixtures/**',
      // Other sessions' git worktrees: their own checkouts, linted there.
      '.claude/worktrees/**',
      'deploy/secrets/**',
      'secrets/**',
    ],
  },
  js.configs.recommended,
  // Airbnb style guide (flat config, TypeScript-aware): base + Node + TypeScript.
  plugins.stylistic,
  plugins.importX,
  plugins.node,
  plugins.typescriptEslint,
  configs.base.recommended,
  configs.node.recommended,
  configs.base.typescript,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts', 'apps/web/vite.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      // Sub-packages carry no `engines`, so lint every file against the root's Node range,
      // and map sources to the built files package.json `bin` points at.
      node: {
        version: '>=26.12.0',
        convertPath: { 'src/**/*.ts': ['^src/(.+)\\.ts$', 'dist/$1.js'] },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      // Deliberate departures from Airbnb, kept to the ones whose rationale does not hold here.
      // Airbnb bans for..of because transpiling it needs regenerator-runtime; Node 26 runs it natively.
      'no-restricted-syntax': ['error', 'ForInStatement', 'LabeledStatement', 'WithStatement'],
      // Modules export by name so barrels re-export and call sites grep the same identifier.
      'import-x/prefer-default-export': 'off',
      // Services open with their public factory and keep hoisted helper functions below it.
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: true, variables: true },
      ],
      // Airbnb's naming rules, plus the leading `_` that marks an intentionally unused binding.
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      // tsc already resolves every import, and CI lints before the workspace packages are built.
      'import-x/no-unresolved': 'off',
    },
  },
  // The SPA in the browser: Airbnb's React, jsx-a11y and hooks rules, plus the React Compiler
  // rules from eslint-plugin-react-hooks.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [
      fixedUp(plugins.react),
      fixedUp(plugins.reactA11y),
      configs.react.recommended,
      configs.react.typescript,
      reactHooks.configs.flat['recommended-latest'],
    ],
    languageOptions: { globals: globals.browser },
    settings: { ...tsxResolution, react: { version: '19.3' } },
    rules: {
      // tsconfig compiles JSX with the automatic runtime ("jsx": "react-jsx"), so React need not be in scope.
      ...plugins.react.plugins.react.configs.flat['jsx-runtime'].rules,
      // React 19 ignores defaultProps on function components; TypeScript's `?` already marks optional props.
      'react/require-default-props': 'off',
    },
  },
  {
    // Process entry points own the exit code and talk to the operator on stdout/stderr.
    files: [
      'apps/server/src/cli.ts',
      'apps/server/src/main.ts',
      'packages/*/src/bin/**',
      'packages/*/src/scripts/**',
      'apps/web/src/scripts/check-bundle.ts',
      'tools/pr-watch/src/main.ts',
    ],
    rules: { 'no-console': 'off', 'n/no-process-exit': 'off' },
  },
  {
    // Node runs the PR watcher's TypeScript sources directly, so its imports name the .ts files
    // (tools/pr-watch/tsconfig.json rewrites them to .js in the build).
    files: ['tools/pr-watch/**'],
    rules: { 'import-x/extensions': ['error', 'ignorePackages', { ts: 'always' }] },
  },
  workspaceDirs.map((dir) => ({
    files: [`${dir}/**`],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          // Airbnb's test globs stop at .ts; the SPA's component tests are .tsx.
          devDependencies: [...helpers.getDevDepsList('typescript'), '**/*.test.tsx'],
          optionalDependencies: false,
          packageDir: [import.meta.dirname, path.join(import.meta.dirname, dir)],
        },
      ],
    },
  })),
  {
    files: ['**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    // n/no-sync needs type information, which the untyped JS config files do not have.
    rules: { 'n/no-sync': 'off' },
  },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  prettier,
);
