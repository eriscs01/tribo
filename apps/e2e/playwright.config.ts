import { defineConfig, devices } from '@playwright/test';

// The walking-skeleton test against a stack that is already running: `pnpm dev:up` locally,
// or deploy/compose.yml with the CI images (CI job "End to end"). TRIBO_E2E_URL is its origin.
export default defineConfig({
  testDir: 'src',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? 'list' : [['github'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.TRIBO_E2E_URL ?? 'https://tribo.localhost',
    // Caddy's internal CA signs both local stacks' certificates; browsers here do not trust it.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
