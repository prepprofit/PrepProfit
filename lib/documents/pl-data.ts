import type { FinanceSummary, MonthlyBucket } from '@/lib/calculations/finance';
import type { PlDocumentData, PlMonthlyRow } from './types';
import { buildSellerIdentity, type SellerSettings } from './seller';

/**
 * Pure mapping from the finance aggregates → the P&L (income statement) view-model
 * (Sprint 3.5B). No I/O: the route loads the period's transactions inside `withOrg`
 * and runs the SAME `financeSummary` / `monthlyBuckets` as `FinancialsContent`, so
 * the document reconciles with the `/financials` screen by construction. Money is
 * integer cents throughout.
 *
 * Category display names are resolved by an injected `resolveCategoryName` (the
 * route passes one backed by next-intl, like the screen's `categoryLabel`); this
 * keeps the builder pure and locale-agnostic.
 */
export function buildPlData(
  summary: FinanceSummary,
  monthly: MonthlyBucket[] | null,
  opts: {
    periodLabel: string;
    view: 'month' | 'year';
    settings: SellerSettings;
    orgNameFallback: string | null;
    /** Resolve a category's display name (slug → i18n, else literal). */
    resolveCategoryName: (c: { slug: string | null; name: string }) => string;
    /** Short month label for a 1–12 month number (year view rows). */
    monthLabel: (month: number) => string;
  },
): PlDocumentData {
  const monthlyRows: PlMonthlyRow[] | null =
    monthly?.map((b) => ({
      label: opts.monthLabel(b.month),
      incomeCents: b.incomeCents,
      expenseCents: b.expenseCents,
      profitCents: b.profitCents,
    })) ?? null;

  return {
    seller: buildSellerIdentity(opts.settings, opts.orgNameFallback),
    periodLabel: opts.periodLabel,
    view: opts.view,
    incomeCents: summary.incomeCents,
    expenseCents: summary.expenseCents,
    profitCents: summary.profitCents,
    byCategory: summary.byCategory.map((c) => ({
      name: opts.resolveCategoryName(c),
      kind: c.kind,
      totalCents: c.totalCents,
    })),
    topProducts: summary.topProducts.map((p) => ({
      name: p.name,
      totalCents: p.totalCents,
    })),
    monthly: monthlyRows,
    currency: opts.settings.currency,
  };
}
