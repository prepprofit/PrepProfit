import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getUserRole } from '@/lib/auth';
import {
  currentPeriodKey,
  isValidPeriodKey,
  resolvePeriod,
  type PeriodView,
} from '@/lib/finance/period';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NoAccess } from '@/components/app/no-access';
import { FinancialsControls } from '@/components/app/finance/financials-controls';
import { FinancialsContent } from '@/components/app/finance/financials-content';
import { FinancialsSkeleton } from '@/components/app/finance/financials-skeleton';

/**
 * Monthly & annual P&L dashboards. Manager-only. The view + period live in the
 * URL so navigation is shareable and the data section streams behind a
 * design-matched skeleton (Suspense) while its query runs.
 */
export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;

  const t = await getTranslations('finance.dashboard');
  const sp = await searchParams;

  const view: PeriodView = sp.view === 'year' ? 'year' : 'month';
  const periodKey =
    typeof sp.period === 'string' && isValidPeriodKey(view, sp.period)
      ? sp.period
      : currentPeriodKey(view);

  const resolved = resolvePeriod(view, periodKey);
  const label =
    view === 'year'
      ? String(resolved.year)
      : new Date(
          resolved.year,
          Number(periodKey.slice(5, 7)) - 1,
          1,
        ).toLocaleDateString('en', { month: 'long', year: 'numeric' });

  const href = (v: PeriodView, key: string) =>
    `/financials?view=${v}&period=${key}`;
  const monthToggleKey =
    view === 'month' ? periodKey : `${resolved.year}-01`;

  const tReports = await getTranslations('reports.actions');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/financials/print?view=${view}&period=${periodKey}`}>
            <FileText className="size-4" />
            {tReports('print')}
          </Link>
        </Button>
      </div>

      <FinancialsControls
        view={view}
        label={label}
        prevHref={href(view, resolved.prevKey)}
        nextHref={href(view, resolved.nextKey)}
        monthHref={href('month', monthToggleKey)}
        yearHref={href('year', String(resolved.year))}
      />

      <Suspense key={`${view}:${periodKey}`} fallback={<FinancialsSkeleton />}>
        <FinancialsContent view={view} periodKey={periodKey} />
      </Suspense>
    </div>
  );
}
