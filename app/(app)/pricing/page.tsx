import { getTranslations } from 'next-intl/server';
import { PricingTable } from '@clerk/nextjs';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { NoAccess } from '@/components/app/no-access';

// Subscriptions are an org-admin / manager concern; never cache (plan state is
// per-session and changes after checkout).
export const dynamic = 'force-dynamic';

/**
 * In-app pricing / plan selection (Sprint 4, slice 4a). Manager-only — kitchen
 * gets NoAccess, and Clerk's checkout itself requires an org admin. Renders the
 * Clerk Organization plans configured in Billing; selecting one opens Clerk's
 * in-app checkout drawer. Reused by onboarding (slice 4d).
 */
export default async function PricingPage() {
  const t = await getTranslations('pricing');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess />;
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      <PricingTable for="organization" />
    </div>
  );
}
