import { clerkSetup } from '@clerk/testing/playwright';
import { test as setup } from '@playwright/test';

/**
 * Clerk testing bootstrap (Sprint 5b). `clerkSetup` exchanges the test-instance
 * secret for a short-lived Testing Token so Playwright can drive Clerk without
 * solving bot/CAPTCHA challenges. No-op-friendly: if the Clerk test env is not
 * configured the authed specs skip themselves, so this only does real work when
 * `CLERK_SECRET_KEY` (test instance) is present.
 */
setup('clerk setup', async () => {
  if (!process.env.CLERK_SECRET_KEY) return;
  await clerkSetup();
});
