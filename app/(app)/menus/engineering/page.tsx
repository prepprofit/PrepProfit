import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { loadMenuEngineering } from '@/lib/data/menu-engineering';
import { cn } from '@/lib/utils';
import { MenuEngineeringMatrix } from '@/components/app/menus/menu-engineering-matrix';

/**
 * Menu Engineering (Sprint 5, AI margin roadmap). Manager-only — mirrors the Profit
 * Insight Inbox guard (kitchen is redirected; margin + sales are financial data).
 * Deterministic, no AI provider call: it classifies the org's SOLD items into the
 * star/puzzle/workhorse/dog matrix over a chosen window (default last 30 days),
 * counting posted sales only and never fabricating a margin for an un-costed item.
 */

const PERIOD_DAYS = [7, 30, 90] as const;
type PeriodDays = (typeof PERIOD_DAYS)[number];
const DEFAULT_DAYS: PeriodDays = 30;

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Inclusive [today − (days − 1), today] window, bare YYYY-MM-DD. */
function periodFor(days: PeriodDays): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: toYmd(from), to: toYmd(today) };
}

export default async function MenuEngineeringPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const t = await getTranslations('menuEngineering');
  const organizationId = await getOrgId();

  if (!canAccessFinancials(await getUserRole())) {
    redirect('/recipes');
  }

  const { days: daysParam } = await searchParams;
  const parsed = Number(daysParam);
  const days: PeriodDays = PERIOD_DAYS.includes(parsed as PeriodDays)
    ? (parsed as PeriodDays)
    : DEFAULT_DAYS;
  const period = periodFor(days);

  const [settings, result] = await Promise.all([
    getOrgSettings(),
    withOrg(organizationId, (tx) => loadMenuEngineering(tx, organizationId, period)),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PERIOD_DAYS.map((option) => (
          <Link
            key={option}
            href={option === DEFAULT_DAYS ? '/menus/engineering' : `?days=${option}`}
            aria-current={option === days ? 'true' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              option === days
                ? 'border-accent-600 bg-accent-600 text-white'
                : 'border-border text-muted-foreground hover:border-accent-300 hover:text-accent-700 dark:hover:text-accent-300',
            )}
          >
            {t(`period.last${option}`)}
          </Link>
        ))}
        <span className="text-xs text-muted-foreground">
          {t('period.range', { from: period.from, to: period.to })}
        </span>
      </div>

      <MenuEngineeringMatrix result={result} currency={settings.currency} />
    </div>
  );
}
