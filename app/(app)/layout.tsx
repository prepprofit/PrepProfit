import { cache } from 'react';
import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/app/app-shell';
import Flows, { type FlowsUserProperties } from '@/app/flows';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { countNeedsPricing } from '@/lib/data/ingredients';
import { getTrialView } from '@/lib/trial';
import { getEffectiveEntitlementState } from '@/lib/entitlements';
import { readActivationSnapshot } from '@/lib/data/activation';
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

// One org transaction for all DB-backed manager layout data (activation snapshot
// for Flows + the needs-pricing sidebar badge) instead of two serial `withOrg`s.
// Layout-local (lib/data stays React-free); entitlement/trial reads stay outside —
// they are Clerk/session-derived, not DB-backed.
const getManagerLayoutDbSnapshot = cache(async () => {
  const organizationId = await getOrgId();
  return withOrg(organizationId, async (tx) => ({
    activation: await readActivationSnapshot(tx, organizationId),
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

  // Trial surfaces, the AI meter, and the Flows onboarding payload are manager-only.
  // Kitchen staff never see checkout/upgrade/onboarding CTAs in v1, so we skip the reads
  // (incl. the entitlement + activation reads) entirely for them.
  const [trial, sidebarAiMeter, entitlement, dbSnapshot] = canSeeFinance
    ? await Promise.all([
        getTrialView(),
        getSidebarAiMeterView(),
        getEffectiveEntitlementState(),
        getManagerLayoutDbSnapshot(),
      ])
    : [null, null, null, null];
  const activation = dbSnapshot?.activation ?? null;
  // Sidebar "Ingredients" badge: how many active ingredients still need a price.
  // Manager-only (pricing is financial); kitchen gets no badge and no extra read.
  const needsPricingCount = dbSnapshot?.needsPricingCount ?? 0;
  const lowestPaidPrice = canSeeFinance
    ? (await getTranslations('marketing.pricing.solo'))('price')
    : '';

  // Coarse activation/trial state for Flows targeting (plan §2). Never names, money, or
  // recipe/ingredient contents. Kitchen falls back to a benign Free/Starter payload but
  // keeps its real role so a future kitchen-onboarding slot can target it.
  const flowsUser: FlowsUserProperties = {
    role,
    source: entitlement?.source ?? 'free',
    tier: entitlement?.tier ?? 'starter',
    isTrial: trial != null,
    trialDaysLeft: trial?.daysLeft ?? null,
    recipeCount: activation?.recipeCount ?? 0,
    hasIngredient: activation?.hasIngredient ?? false,
    hasRunPhotoExtraction: activation?.hasRunPhotoExtraction ?? false,
  };

  return (
    <Flows user={flowsUser}>
      <AppShell
        canSeeFinance={canSeeFinance}
        trial={trial}
        sidebarAiMeter={sidebarAiMeter}
        lowestPaidPrice={lowestPaidPrice}
        needsPricingCount={needsPricingCount}
      >
        {children}
      </AppShell>
    </Flows>
  );
}
