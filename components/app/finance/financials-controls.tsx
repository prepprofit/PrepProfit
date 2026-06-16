import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PeriodView } from '@/lib/finance/period';
import { cn } from '@/lib/utils';

/**
 * Period switcher (Month ⇄ Year) + prev/next navigation. Pure Link navigation —
 * the server re-renders for the new period, so no client state is needed. Lives
 * outside the data Suspense boundary, so it stays interactive while data loads.
 */
export async function FinancialsControls({
  view,
  label,
  prevHref,
  nextHref,
  monthHref,
  yearHref,
}: {
  view: PeriodView;
  label: string;
  prevHref: string;
  nextHref: string;
  monthHref: string;
  yearHref: string;
}) {
  const t = await getTranslations('finance.period');

  const tab = (active: boolean) =>
    cn(
      'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
      active
        ? 'bg-accent-700 text-white'
        : 'text-muted-foreground hover:bg-surface-2',
    );

  const navBtn =
    'flex size-9 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-full border border-border bg-surface p-1">
        <Link href={monthHref} className={tab(view === 'month')}>
          {t('month')}
        </Link>
        <Link href={yearHref} className={tab(view === 'year')}>
          {t('year')}
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <Link href={prevHref} aria-label={t('previous')} className={navBtn}>
          <ChevronLeft className="size-4" />
        </Link>
        <span className="min-w-32 text-center text-sm font-medium text-foreground">
          {label}
        </span>
        <Link href={nextHref} aria-label={t('next')} className={navBtn}>
          <ChevronRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}
