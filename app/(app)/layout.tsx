import { cache } from 'react';
import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/app/app-shell';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { countNeedsPricing } from '@/lib/data/ingredients';
import { getTrialView } from '@/lib/trial';
import {
  buildSidebarAiMeterView,
  getAiUsageThisMonth,
  type SidebarAiMeterView,
} from '@/lib/data/ai-usage';

// Cached on the layout side (not in `lib/data/*`, which stays React-free) so the single
// server read is shared with any other per-request caller and never duplicated. Reads
// every metered feature so the sidebar meter can page left/right through them.
const getSidebarAiMeterView = cache(
  async (): Promise<SidebarAiMeterView | null> =>
    buildSidebarAiMeterView(await getAiUsageThisMonth()),
);

// One org transaction for all DB-backed manager layout data.
// Layout-local (lib/data stays React-free); trial reads stay outside — they are
// Clerk/session-derived, not DB-backed.
const getManagerLayoutDbSnapshot = cache(async () => {
  const organizationId = await getOrgId();
  return withOrg(organizationId, async (tx) => ({
    needsPricingCount: await countNeedsPricing(tx, organizationId),
  }));
});

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Role drives the cosmetic nav (the Finance group is hidden for kitchen staff);
  // the real enforcement lives in each finance page + action.
  const role = await getUserRole();
  const canSeeFinance = canAccessFinancials(role);

  // Trial surfaces and the AI meter are manager-only.
  // Kitchen staff never see checkout/upgrade/onboarding CTAs in v1, so we skip the reads
  // entirely for them.
  const [trial, sidebarAiMeter, dbSnapshot] = canSeeFinance
    ? await Promise.all([
        getTrialView(),
        getSidebarAiMeterView(),
        getManagerLayoutDbSnapshot(),
      ])
    : [null, null, null];
  // Sidebar "Ingredients" badge: how many active ingredients still need a price.
  // Manager-only (pricing is financial); kitchen gets no badge and no extra read.
  const needsPricingCount = dbSnapshot?.needsPricingCount ?? 0;
  const lowestPaidPrice = canSeeFinance
    ? (await getTranslations('marketing.pricing.solo'))('price')
    : '';

  return (
    <AppShell
      canSeeFinance={canSeeFinance}
      trial={trial}
      sidebarAiMeter={sidebarAiMeter}
      lowestPaidPrice={lowestPaidPrice}
      needsPricingCount={needsPricingCount}
    >
      {children}
    </AppShell>
  );
}
