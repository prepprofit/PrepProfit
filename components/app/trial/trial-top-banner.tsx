'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import type { TrialView } from '@/lib/trial';

/** Paths (and their nested routes) where the persistent trial banner is suppressed. */
const HIDDEN_PREFIXES = ['/dashboard', '/billing', '/pricing', '/onboarding'];

/**
 * Full-width reverse-trial strip above the app chrome (manager-only, active trial only).
 * Persistent in v1 (no dismiss). Hidden on the dashboard (which shows the richer card)
 * and on billing/pricing/onboarding where an upsell would be redundant. Renders nothing
 * outside an active trial, so the parent can mount it unconditionally.
 */
export function TrialTopBanner({
  trial,
  lowestPaidPrice,
}: {
  trial: TrialView | null;
  lowestPaidPrice: string;
}) {
  const t = useTranslations('trial');
  const pathname = usePathname();

  if (trial == null) return null;
  const hidden = HIDDEN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (hidden) return null;

  const daysLabel = t('daysLeft', { days: trial.daysLeft });

  return (
    <div className="flex shrink-0 items-center justify-center gap-x-3 gap-y-1 border-b border-accent-200 bg-accent-50 px-4 py-2 text-sm dark:border-accent-500/20 dark:bg-accent-500/10">
      <Info className="size-4 shrink-0 text-accent-600" aria-hidden />
      <span className="text-foreground">
        {t('banner.body', { daysLabel, price: lowestPaidPrice })}
      </span>
      <Link
        href="/pricing"
        className="shrink-0 font-medium text-accent-700 underline-offset-2 hover:underline dark:text-accent-300"
      >
        {t('banner.cta')}
      </Link>
    </div>
  );
}
