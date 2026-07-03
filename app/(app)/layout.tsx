import { cache } from 'react';
import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/app/app-shell';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { getTrialView } from '@/lib/trial';
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

  // Trial surfaces + the AI meter are manager-only. Kitchen staff never see checkout or
  // upgrade CTAs, so we skip the reads entirely for them.
  const trial = canSeeFinance ? await getTrialView() : null;
  const sidebarAiMeter = canSeeFinance ? await getSidebarAiMeterView() : null;
  const lowestPaidPrice = canSeeFinance
    ? (await getTranslations('marketing.pricing.solo'))('price')
    : '';

  return (
    <AppShell
      canSeeFinance={canSeeFinance}
      trial={trial}
      sidebarAiMeter={sidebarAiMeter}
      lowestPaidPrice={lowestPaidPrice}
    >
      {children}
    </AppShell>
  );
}
