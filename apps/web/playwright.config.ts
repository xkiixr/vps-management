import { defineConfig, devices } from '@playwright/test'
import { E2E_ORIGIN } from './e2e/env'

// Browser smoke test of the production build (`next build`, then the standalone server), against a scratch
// database. It only runs with E2E=1, because it builds the dashboard and needs the test Postgres
// (TEST_DATABASE_URL, default postgres://postgres:test@localhost:54329/postgres):
//   E2E=1 corepack pnpm --filter @vpsm/web exec playwright test
// First time: corepack pnpm --filter @vpsm/web exec playwright install chromium
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  // One server and one database, and the tests build on each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  globalSetup: process.env.E2E === '1' ? './e2e/global-setup.ts' : undefined,
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
