import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import { getPlanTier, PLAN_LIMITS } from '@/lib/entitlements';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { NoAccess } from '@/components/app/no-access';

// Plan state is per-session and changes after checkout; never cache.
export const dynamic = 'force-dynamic';

/**
 * Billing overview (Sprint 4, slice 4a). Manager-only. Shows the active org's
 * plan tier (read fail-closed via `getPlanTier`) and its limits, with a link to
 * `/pricing` to upgrade/downgrade. The tier here is for DISPLAY only — access is
 * always re-checked server-side via the entitlements helpers.
 */
export default async function BillingPage() {
  const t = await getTranslations('billing');

  if (!canAccessFinancials(await getUserRole())) {
    return <NoAccess />;
  }

  const tier = await getPlanTier();
  const limits = PLAN_LIMITS[tier];
  const recipes =
    limits.recipes === Infinity ? t('recipesUnlimited') : String(limits.recipes);
  const seats =
    limits.seats === Infinity ? t('seatsUnlimited') : String(limits.seats);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('subtitle')}</p>

      <Card>
        <CardContent className="flex flex-col gap-5 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('currentPlan')}
              </span>
              <span className="font-display text-xl font-semibold text-foreground">
                {t(`tier.${tier}`)}
              </span>
            </div>
            <Button asChild size="sm">
              <Link href="/pricing">
                {t('viewPlans')}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>

          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{t('recipes')}</dt>
              <dd className="font-medium text-foreground">{recipes}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{t('seats')}</dt>
              <dd className="font-medium text-foreground">{seats}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
