import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config (Sprint 5b). Separate from the Vitest unit/integration
 * suite (Vitest owns `*.test.ts`; Playwright owns `tests/e2e/*.spec.ts`), so the
 * two never collide. The authed smoke needs a Clerk TEST instance + a seeded user;
 * when those secrets are absent the authed specs skip themselves (see smoke.spec.ts)
 * so a credential-less `npx playwright test` still runs the public checks and passes.
 *
 * The webServer builds + starts the real app once, then all specs hit it. In CI we
 * never reuse a server; locally we reuse a running dev server if present.
 */
const PORT = process.env.E2E_PORT ?? '3000';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // iPhone/WebKit: every iOS browser is WebKit, and its hydration/transition
    // timing has crashed the app router where Chromium passed (2026-07-08
    // incident: consent mount-effect setState → "Rendered more hooks…").
    {
      name: 'webkit',
      use: { ...devices['iPhone 13'] },
      dependencies: ['setup'],
    },
  ],
  // Skip standing up a server when pointing at an already-running/remote target.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
