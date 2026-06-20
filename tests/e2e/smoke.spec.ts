import { test, expect } from '@playwright/test';
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';

/**
 * Launch smoke (Sprint 5b). Two tiers:
 *  - PUBLIC: always runs, no secrets. Proves the marketing landing + Clerk sign-in
 *    surface render and link together.
 *  - AUTHED (manager): runs only when a Clerk TEST instance + seeded manager user are
 *    configured (E2E_USER_EMAIL/E2E_USER_PASSWORD + CLERK_SECRET_KEY). Signs in and
 *    asserts the sensitive manager routes render (no redirect back to /sign-in).
 *  - RBAC (kitchen): runs only when a seeded kitchen user is configured. Proves a
 *    non-manager is blocked from a sensitive route (NoAccess), not just UI-hidden.
 *
 * Mutating flows (create recipe/transaction/invoice) are intentionally left to a
 * follow-up with seeded fixtures — a navigation+RBAC smoke is the "one reliable"
 * E2E the launch gate needs; brittle UI-mutation steps would undermine that.
 */

const managerConfigured =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.E2E_USER_EMAIL &&
  !!process.env.E2E_USER_PASSWORD;

const kitchenConfigured =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.E2E_KITCHEN_EMAIL &&
  !!process.env.E2E_KITCHEN_PASSWORD;

test.describe('public', () => {
  test('landing page renders and links to sign-in', async ({ page }) => {
    await page.goto('/');
    // The hero CTA + secondary sign-in link are the always-present anchors.
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
  });

  test('sign-in page renders the Clerk form', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByText(/sign in/i).first()).toBeVisible();
  });
});

test.describe('authed manager', () => {
  test.skip(!managerConfigured, 'Clerk test instance + E2E_USER_* not configured');

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.goto('/sign-in');
    await clerk.signIn({
      page,
      signInParams: {
        strategy: 'password',
        identifier: process.env.E2E_USER_EMAIL!,
        password: process.env.E2E_USER_PASSWORD!,
      },
    });
  });

  test('manager reaches dashboard and sensitive routes', async ({ page }) => {
    for (const path of ['/dashboard', '/recipes', '/financials', '/invoices']) {
      await page.goto(path);
      // A signed-in manager must not be bounced to auth or org selection.
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page).not.toHaveURL(/sign-in/);
    }
  });
});

test.describe('kitchen RBAC', () => {
  test.skip(!kitchenConfigured, 'kitchen E2E_KITCHEN_* user not configured');

  test('kitchen is blocked from a sensitive route', async ({ page }) => {
    await setupClerkTestingToken({ page });
    await page.goto('/sign-in');
    await clerk.signIn({
      page,
      signInParams: {
        strategy: 'password',
        identifier: process.env.E2E_KITCHEN_EMAIL!,
        password: process.env.E2E_KITCHEN_PASSWORD!,
      },
    });
    // /financials is manager-only: the server renders NoAccess for kitchen, it is
    // never silently allowed. Assert the access-denied copy is shown.
    await page.goto('/financials');
    await expect(page.getByText(/access|permission|not allowed/i).first()).toBeVisible();
  });
});
