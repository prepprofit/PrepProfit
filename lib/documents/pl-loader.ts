import { getOrgId, getOrgName } from '@/lib/auth';
import { withOrg } from '@/lib/db';
import { listTransactions } from '@/lib/data/transactions';
import { getOrgSettingsRow, DEFAULT_ORG_SETTINGS } from '@/lib/data/org-settings';
import { financeSummary, monthlyBuckets } from '@/lib/calculations/finance';
import { categoryLabel } from '@/lib/finance/categories';
import { resolvePeriod, type PeriodView } from '@/lib/finance/period';
import { buildPlData } from './pl-data';
import type { PlDocumentData } from './types';

/**
 * Server-side loader shared by the P&L PDF/XLSX routes AND the print page, so all
 * three render the SAME numbers as `/financials`. Org-scoped (RULE #1): the org id
 * comes from `getOrgId()` and the read runs inside `withOrg`. Mirrors
 * `FinancialsContent`: current-period transactions → `financeSummary`, plus monthly
 * buckets in the year view.
 *
 * The seller logo is the raw stored URL — the PDF route replaces it with SSRF-safe
 * local bytes (`loadSafeLogo`); the print page renders it through the client
 * `PrintLogo`. Category display names are resolved via the passed `tCat` translator.
 */
const shortMonth = (month: number) =>
  new Date(2000, month - 1, 1).toLocaleDateString('en', { month: 'short' });

export function periodLabel(view: PeriodView, periodKey: string): string {
  const resolved = resolvePeriod(view, periodKey);
  if (view === 'year') return String(resolved.year);
  return new Date(
    resolved.year,
    Number(periodKey.slice(5, 7)) - 1,
    1,
  ).toLocaleDateString('en', { month: 'long', year: 'numeric' });
}

export async function loadPlDocument(opts: {
  view: PeriodView;
  periodKey: string;
  /** `finance.categories` translator (slug → display). */
  tCat: (slug: string) => string;
}): Promise<PlDocumentData> {
  const organizationId = await getOrgId();
  const resolved = resolvePeriod(opts.view, opts.periodKey);

  const { current, settings } = await withOrg(organizationId, async (tx) => {
    const current = await listTransactions(tx, organizationId, {
      from: resolved.from,
      to: resolved.to,
    });
    const settings = await getOrgSettingsRow(tx, organizationId);
    return { current, settings };
  });

  const resolvedSettings = settings ?? DEFAULT_ORG_SETTINGS;
  const orgName = resolvedSettings.businessName?.trim() ? null : await getOrgName();

  const summary = financeSummary(current);
  const monthly =
    opts.view === 'year' ? monthlyBuckets(current, resolved.year) : null;

  return buildPlData(summary, monthly, {
    periodLabel: periodLabel(opts.view, opts.periodKey),
    view: opts.view,
    settings: resolvedSettings,
    orgNameFallback: orgName,
    resolveCategoryName: (c) => categoryLabel(c, opts.tCat),
    monthLabel: shortMonth,
  });
}
