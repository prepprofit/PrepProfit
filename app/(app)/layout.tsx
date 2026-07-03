import { cache } from 'react';
import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/app/app-shell';
import Flows, { type FlowsUserProperties } from '@/app/flows';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { getTrialView } from '@/lib/trial';
import { getEffectiveEntitlementState } from '@/lib/entitlements';
import { getActivationSnapshot } from '@/lib/data/activation';
import {
  buildSidebarAiMeterView,
  getPhotoExtractionUsageSummaryThisMonth,
  type SidebarAiMeterView,
} from '@/lib/data/ai-usage';

// Cached on the layout side (not in `lib/data/*`, which stays React-free) so the single
// server read is shared with any other per-request caller and never duplicated.
const getSidebarAiMeterView = cache(
  async (): Promise<SidebarAiMeterView | null> =>
    buildSidebarAiMeterView(await getPhotoExtractionUsageSummaryThisMonth()),
);

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
  const [trial, sidebarAiMeter, entitlement, activation] = canSeeFinance
    ? await Promise.all([
        getTrialView(),
        getSidebarAiMeterView(),
        getEffectiveEntitlementState(),
        getActivationSnapshot(),
      ])
    : [null, null, null, null];
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
      >
        {children}
      </AppShell>
    </Flows>
  );
}
