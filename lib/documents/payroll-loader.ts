import { getOrgId, getOrgName } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listEmployees } from '@/lib/data/employees';
import { listShiftsInPeriod } from '@/lib/data/shifts';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { resolvePayrollPeriod, type PayrollView } from '@/lib/payroll/period';
import { buildPayrollData } from './payroll-data';
import type { PayrollDocumentData } from './types';

/**
 * Server-side loader shared by the payroll-summary PDF/XLSX routes AND the print
 * page, so all three render the SAME figures as `/payroll`. Org-scoped (RULE #1):
 * the org id comes from `getOrgId()` and the read runs inside `withOrg`. Active
 * employees only (the screen's default); shifts are attributed to the period their
 * start instant falls in (half-open [from, to)).
 *
 * The seller logo is the raw stored URL — the PDF route swaps it for SSRF-safe
 * local bytes; the print page renders it through the client `PrintLogo`.
 */
export function payrollPeriodLabel(view: PayrollView, anchor: string): string {
  const period = resolvePayrollPeriod(view, anchor);
  const startDate = new Date(period.fromMs);
  if (view === 'month') {
    return startDate.toLocaleDateString('en', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  return `${startDate.toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })} – ${new Date(period.toMs - 1).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })}`;
}

export async function loadPayrollDocument(opts: {
  view: PayrollView;
  anchor: string;
}): Promise<PayrollDocumentData> {
  const organizationId = await getOrgId();
  const period = resolvePayrollPeriod(opts.view, opts.anchor);

  const { employees, shifts, settings } = await withOrg(
    organizationId,
    async (tx) => {
      const employees = await listEmployees(tx, organizationId);
      const shifts = await listShiftsInPeriod(tx, organizationId, {
        fromMs: period.fromMs,
        toMs: period.toMs,
      });
      const settings = await getOrgSettingsRow(tx, organizationId);
      return { employees, shifts, settings };
    },
  );

  const resolvedSettings = settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = resolvedSettings.businessName?.trim() ? null : await getOrgName();

  return buildPayrollData(employees, shifts, {
    periodLabel: payrollPeriodLabel(opts.view, opts.anchor),
    view: opts.view,
    settings: resolvedSettings,
    orgNameFallback: orgName,
  });
}
