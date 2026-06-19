import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { canAccessFinancials, getOrgId, getUserRole } from '@/lib/auth';
import { canUseFeature } from '@/lib/entitlements';
import { withOrg } from '@/lib/db';
import { getOrgSettings } from '@/lib/data/org-settings';
import { listEmployees } from '@/lib/data/employees';
import { listShiftsInPeriod } from '@/lib/data/shifts';
import {
  payrollSummary,
  shiftPayCents,
  shiftWorkedMinutes,
} from '@/lib/calculations/payroll';
import {
  isValidAnchor,
  resolvePayrollPeriod,
  todayAnchor,
  type PayrollView,
} from '@/lib/payroll/period';
import { cn } from '@/lib/utils';
import { NoAccess } from '@/components/app/no-access';
import { UpgradeRequired } from '@/components/app/upgrade-required';
import { PayrollWorkspace } from '@/components/app/payroll/payroll-workspace';

/**
 * Payroll (module 5). Manager-only (kitchen gets NoAccess + every action blocks).
 * The period (week/month) lives in the URL so navigation is shareable. Shifts are
 * attributed to the period their start instant falls in; hours + pay are derived
 * by the pure payroll calc.
 */
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!canAccessFinancials(await getUserRole())) return <NoAccess />;
  if (!(await canUseFeature('payroll'))) return <UpgradeRequired />;

  const t = await getTranslations('payroll');
  const sp = await searchParams;
  const organizationId = await getOrgId();

  const view: PayrollView = sp.view === 'week' ? 'week' : 'month';
  const anchor =
    typeof sp.d === 'string' && isValidAnchor(sp.d) ? sp.d : todayAnchor();
  const showArchived = sp.archived === '1';
  const period = resolvePayrollPeriod(view, anchor);

  const [data, settings] = await Promise.all([
    withOrg(organizationId, async (tx) => {
      const employees = await listEmployees(tx, organizationId, {
        includeArchived: showArchived,
      });
      const shifts = await listShiftsInPeriod(tx, organizationId, {
        fromMs: period.fromMs,
        toMs: period.toMs,
      });
      return { employees, shifts };
    }),
    getOrgSettings(),
  ]);

  const rateById = new Map(data.employees.map((e) => [e.id, e.hourlyRateCents]));
  const nameById = new Map(data.employees.map((e) => [e.id, e.name]));

  // Per-employee summary across the period's shifts.
  const summaries = data.employees.map((e) => {
    const theirShifts = data.shifts
      .filter((s) => s.employeeId === e.id)
      .map((s) => ({
        startedAtMs: s.startedAt.getTime(),
        endedAtMs: s.endedAt ? s.endedAt.getTime() : null,
        breakMinutes: s.breakMinutes,
      }));
    const summary = payrollSummary(theirShifts, e.hourlyRateCents);
    return {
      employeeId: e.id,
      name: e.name,
      shiftCount: summary.shiftCount,
      workedMinutes: summary.workedMinutes,
      payDueCents: summary.payDueCents,
    };
  });

  const shiftRows = data.shifts.map((s) => {
    const calcShift = {
      startedAtMs: s.startedAt.getTime(),
      endedAtMs: s.endedAt ? s.endedAt.getTime() : null,
      breakMinutes: s.breakMinutes,
    };
    return {
      id: s.id,
      employeeId: s.employeeId,
      employeeName: nameById.get(s.employeeId) ?? '',
      startedAtMs: calcShift.startedAtMs,
      endedAtMs: calcShift.endedAtMs,
      breakMinutes: s.breakMinutes,
      note: s.note,
      workedMinutes: shiftWorkedMinutes(calcShift),
      payCents: shiftPayCents(calcShift, rateById.get(s.employeeId) ?? 0),
    };
  });

  // Period label + navigation hrefs (server Links; no client state needed).
  const startDate = new Date(period.fromMs);
  const label =
    view === 'month'
      ? startDate.toLocaleDateString('en', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : `${startDate.toLocaleDateString('en', {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        })} – ${new Date(period.toMs - 1).toLocaleDateString('en', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })}`;

  const href = (v: PayrollView, d: string) =>
    `/payroll?view=${v}&d=${d}${showArchived ? '&archived=1' : ''}`;

  const tab = (active: boolean) =>
    cn(
      'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
      active ? 'bg-accent-700 text-white' : 'text-muted-foreground hover:bg-surface-2',
    );
  const navBtn =
    'flex size-9 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground';

  const tReports = await getTranslations('reports.actions');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/payroll/print?view=${view}&d=${anchor}`}>
            <FileText className="size-4" />
            {tReports('print')}
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full border border-border bg-surface p-1">
          <Link href={href('week', period.anchor)} className={tab(view === 'week')}>
            {t('summary.week')}
          </Link>
          <Link href={href('month', period.anchor)} className={tab(view === 'month')}>
            {t('summary.month')}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={href(view, period.prevAnchor)}
            aria-label={t('nav.previous')}
            className={navBtn}
          >
            <ChevronLeft className="size-4" />
          </Link>
          <span className="min-w-40 text-center text-sm font-medium text-foreground">
            {label}
          </span>
          <Link
            href={href(view, period.nextAnchor)}
            aria-label={t('nav.next')}
            className={navBtn}
          >
            <ChevronRight className="size-4" />
          </Link>
        </div>
      </div>

      <PayrollWorkspace
        currency={settings.currency}
        showArchived={showArchived}
        toggleArchivedHref={`/payroll?view=${view}&d=${anchor}${showArchived ? '' : '&archived=1'}`}
        employees={data.employees.map((e) => ({
          id: e.id,
          name: e.name,
          email: e.email,
          hourlyRateCents: e.hourlyRateCents,
          active: e.active,
        }))}
        shifts={shiftRows}
        summaries={summaries}
      />
    </div>
  );
}
