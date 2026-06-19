import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { getOrgSettings } from '@/lib/data/org-settings';
import { OnboardingStepper } from './onboarding-stepper';

// Plan selection (PricingTable) is per-session and onboarding state changes on
// completion — never cache this route.
export const dynamic = 'force-dynamic';

/**
 * Post-signup onboarding (Sprint 4d). A guided, one-time flow for a new org's
 * manager: set up the business identity, choose a plan, and take a short tour.
 *
 * Entry is the /dashboard gate (a not-yet-onboarded manager is redirected here);
 * this page is the single place the flow lives. Manager-only — kitchen staff
 * can't configure the org, so they're sent to their workspace. Already-onboarded
 * managers are bounced to the dashboard so the flow is never re-entered.
 */
export default async function OnboardingPage() {
  const t = await getTranslations('onboarding');

  if (!canAccessFinancials(await getUserRole())) {
    redirect('/recipes');
  }

  const settings = await getOrgSettings();
  if (settings.onboardedAt != null) {
    redirect('/dashboard');
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <OnboardingStepper
        settings={{
          currency: settings.currency,
          measurementSystem: settings.measurementSystem,
          businessName: settings.businessName,
          businessAddress: settings.businessAddress,
          businessTaxId: settings.businessTaxId,
          businessEmail: settings.businessEmail,
          businessLogoUrl: settings.businessLogoUrl,
        }}
      />
    </div>
  );
}
