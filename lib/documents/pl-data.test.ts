import { describe, expect, it } from 'vitest';
import { buildPlData } from './pl-data';
import { financeSummary, monthlyBuckets, type FinanceTxn } from '@/lib/calculations/finance';
import type { SellerSettings } from './seller';

/**
 * The P&L view-model must reconcile with the SAME finance aggregates the
 * /financials screen uses.
 */
const settings: SellerSettings = {
  currency: 'EUR',
  businessName: 'Padaria',
  businessAddress: null,
  businessTaxId: null,
  businessEmail: null,
  businessLogoUrl: null,
};

const cat = (slug: string | null, name: string, kind: 'income' | 'expense') => ({
  id: slug ?? name,
  slug,
  name,
  kind,
});

const txns: FinanceTxn[] = [
  { type: 'income', amountCents: 10000, occurredOn: '2026-06-02', category: cat('food_sales', 'Food sales', 'income'), recipe: { id: 'r1', name: 'Bread' } },
  { type: 'income', amountCents: 5000, occurredOn: '2026-06-10', category: cat('food_sales', 'Food sales', 'income'), recipe: { id: 'r1', name: 'Bread' } },
  { type: 'expense', amountCents: 3000, occurredOn: '2026-06-05', category: cat('rent', 'Rent', 'expense'), recipe: null },
  { type: 'expense', amountCents: 2000, occurredOn: '2026-06-08', category: cat(null, 'Custom thing', 'expense'), recipe: null },
];

const opts = {
  periodLabel: 'June 2026',
  view: 'month' as const,
  settings,
  orgNameFallback: null,
  resolveCategoryName: (c: { slug: string | null; name: string }) => c.name,
  monthLabel: (m: number) => `M${m}`,
};

describe('buildPlData', () => {
  it('reconciles income/expense/profit with financeSummary', () => {
    const summary = financeSummary(txns);
    const data = buildPlData(summary, null, opts);
    expect(data.incomeCents).toBe(summary.incomeCents);
    expect(data.expenseCents).toBe(summary.expenseCents);
    expect(data.profitCents).toBe(summary.profitCents);
    expect(data.incomeCents).toBe(15000);
    expect(data.expenseCents).toBe(5000);
    expect(data.profitCents).toBe(10000);
  });

  it('reconciles by-category and top-products with financeSummary', () => {
    const summary = financeSummary(txns);
    const data = buildPlData(summary, null, opts);
    expect(data.byCategory).toHaveLength(summary.byCategory.length);
    expect(data.byCategory.map((c) => c.totalCents)).toEqual(
      summary.byCategory.map((c) => c.totalCents),
    );
    expect(data.topProducts[0]).toEqual({ name: 'Bread', totalCents: 15000 });
  });

  it('includes 12 monthly rows in the year view, resolving labels', () => {
    const summary = financeSummary(txns);
    const monthly = monthlyBuckets(txns, 2026);
    const data = buildPlData(summary, monthly, { ...opts, view: 'year' });
    expect(data.monthly).toHaveLength(12);
    expect(data.monthly![5]).toEqual({
      label: 'M6',
      incomeCents: 15000,
      expenseCents: 5000,
      profitCents: 10000,
    });
  });

  it('handles a loss (negative profit) and zero activity', () => {
    const lossTxns: FinanceTxn[] = [
      { type: 'expense', amountCents: 9000, occurredOn: '2026-06-01', category: cat('rent', 'Rent', 'expense'), recipe: null },
    ];
    const data = buildPlData(financeSummary(lossTxns), null, opts);
    expect(data.profitCents).toBe(-9000);

    const empty = buildPlData(financeSummary([]), null, opts);
    expect(empty.incomeCents).toBe(0);
    expect(empty.byCategory).toEqual([]);
    expect(empty.topProducts).toEqual([]);
  });
});
