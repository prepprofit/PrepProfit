import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { loadCfoReport, defaultCfoWeekTo } from '@/lib/data/cfo-report';
import { cn } from '@/lib/utils';
import { CfoReportView } from '@/components/app/reports/cfo-report-view';
import { CfoReportSummaryCard } from '@/components/app/reports/cfo-report-summary-card';

/**
 * Weekly CFO Report (Sprint 8, AI margin roadmap; plan §13). Manager-only — mirrors the
 * Profit Insight Inbox / Menu Engineer guard (kitchen is redirected; the report is financial:
 * revenue, food cost, margins, supplier prices). Deterministic: the report is a management
 * view over the trusted insight modules, computed server-side; the optional premium AI
 * write-up is a separate metered card. The week ends on `?weekTo=` (default: the last full 7
 * days ending today), with a quick "last week" toggle.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymdMinusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function CfoReportPage({
  searchParams,
}: {
  searchParams: Promise<{ weekTo?: string }>;
}) {
  const t = await getTranslations('cfoReport');
  const organizationId = await getOrgId();

  if (!canAccessFinancials(await getUserRole())) {
    redirect('/recipes');
  }

  const thisWeekTo = defaultCfoWeekTo();
  const lastWeekTo = ymdMinusDays(thisWeekTo, 7);
  const { weekTo: weekToParam } = await searchParams;
  const weekTo =
    weekToParam && YMD.test(weekToParam) ? weekToParam : thisWeekTo;

  const [settings, report] = await Promise.all([
    getOrgSettings(),
    withOrg(organizationId, (tx) => loadCfoReport(tx, organizationId, weekTo)),
  ]);

  const presets: { key: string; weekTo: string }[] = [
    { key: 'thisWeek', weekTo: thisWeekTo },
    { key: 'lastWeek', weekTo: lastWeekTo },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <Link
            key={p.key}
            href={p.weekTo === thisWeekTo ? '/reports/cfo' : `?weekTo=${p.weekTo}`}
            aria-current={p.weekTo === weekTo ? 'true' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              p.weekTo === weekTo
                ? 'border-accent-600 bg-accent-600 text-white'
                : 'border-border text-muted-foreground hover:border-accent-300 hover:text-accent-700 dark:hover:text-accent-300',
            )}
          >
            {t(`period.${p.key}`)}
          </Link>
        ))}
        <span className="text-xs text-muted-foreground">
          {t('period.range', { from: report.weekFrom, to: report.weekTo })}
        </span>
      </div>

      <CfoReportSummaryCard weekTo={weekTo} />
      <CfoReportView report={report} currency={settings.currency} />
    </div>
  );
}
