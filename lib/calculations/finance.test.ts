import { describe, expect, it } from 'vitest';
import {
  financeSummary,
  monthlyBuckets,
  comparePeriods,
  type FinanceTxn,
} from './finance';

function income(
  amountCents: number,
  occurredOn: string,
  category: { id: string; name: string; slug?: string | null },
  recipe?: { id: string; name: string },
): FinanceTxn {
  return {
    type: 'income',
    amountCents,
    occurredOn,
    category: { id: category.id, name: category.name, slug: category.slug ?? null, kind: 'income' },
    recipe: recipe ?? null,
  };
}

function expense(
  amountCents: number,
  occurredOn: string,
  category: { id: string; name: string; slug?: string | null },
): FinanceTxn {
  return {
    type: 'expense',
    amountCents,
    occurredOn,
    category: { id: category.id, name: category.name, slug: category.slug ?? null, kind: 'expense' },
    recipe: null,
  };
}

const SALES = { id: 'c_sales', name: 'Food sales', slug: 'food_sales' };
const RENT = { id: 'c_rent', name: 'Rent', slug: 'rent' };
const CAKE = { id: 'r_cake', name: 'Cake' };
const BREAD = { id: 'r_bread', name: 'Bread' };

describe('financeSummary', () => {
  it('returns all zeros for no transactions', () => {
    const s = financeSummary([]);
    expect(s).toEqual({
      incomeCents: 0,
      expenseCents: 0,
      profitCents: 0,
      byCategory: [],
      topProducts: [],
    });
  });

  it('sums income, expense, and profit', () => {
    const s = financeSummary([
      income(10_000, '2026-06-01', SALES),
      income(5_000, '2026-06-02', SALES),
      expense(4_000, '2026-06-03', RENT),
    ]);
    expect(s.incomeCents).toBe(15_000);
    expect(s.expenseCents).toBe(4_000);
    expect(s.profitCents).toBe(11_000);
  });

  it('reports a negative profit when expenses exceed income', () => {
    const s = financeSummary([
      income(3_000, '2026-06-01', SALES),
      expense(8_000, '2026-06-02', RENT),
    ]);
    expect(s.profitCents).toBe(-5_000);
  });

  it('groups by category and sorts by total descending', () => {
    const s = financeSummary([
      expense(2_000, '2026-06-01', RENT),
      income(9_000, '2026-06-02', SALES),
      income(1_000, '2026-06-03', SALES),
    ]);
    expect(s.byCategory.map((c) => [c.categoryId, c.totalCents])).toEqual([
      ['c_sales', 10_000],
      ['c_rent', 2_000],
    ]);
  });

  it('builds top products from income with a recipe, capped and sorted', () => {
    const s = financeSummary(
      [
        income(4_000, '2026-06-01', SALES, CAKE),
        income(3_000, '2026-06-02', SALES, CAKE),
        income(5_000, '2026-06-03', SALES, BREAD),
        income(9_000, '2026-06-04', SALES), // no recipe → excluded
      ],
      1,
    );
    expect(s.topProducts).toEqual([
      { recipeId: 'r_cake', name: 'Cake', totalCents: 7_000 },
    ]);
  });

  it('excludes expenses from top products even if they carry a recipe', () => {
    const withRecipeExpense: FinanceTxn = {
      ...expense(2_000, '2026-06-01', RENT),
      recipe: { id: 'r_cake', name: 'Cake' },
    };
    const s = financeSummary([withRecipeExpense]);
    expect(s.topProducts).toEqual([]);
  });
});

describe('monthlyBuckets', () => {
  it('returns 12 zeroed buckets for an empty year', () => {
    const buckets = monthlyBuckets([], 2026);
    expect(buckets).toHaveLength(12);
    expect(buckets.every((b) => b.incomeCents === 0 && b.expenseCents === 0)).toBe(true);
    expect(buckets[0]!.month).toBe(1);
    expect(buckets[11]!.month).toBe(12);
  });

  it('buckets by calendar month and ignores other years', () => {
    const buckets = monthlyBuckets(
      [
        income(10_000, '2026-01-15', SALES),
        expense(3_000, '2026-01-20', RENT),
        income(7_000, '2026-03-01', SALES),
        income(99_000, '2025-01-01', SALES), // different year → ignored
      ],
      2026,
    );
    expect(buckets[0]).toEqual({ month: 1, incomeCents: 10_000, expenseCents: 3_000, profitCents: 7_000 });
    expect(buckets[2]).toEqual({ month: 3, incomeCents: 7_000, expenseCents: 0, profitCents: 7_000 });
    expect(buckets[1]).toEqual({ month: 2, incomeCents: 0, expenseCents: 0, profitCents: 0 });
  });
});

describe('comparePeriods', () => {
  it('computes delta and percent change', () => {
    expect(comparePeriods(12_000, 10_000)).toEqual({
      currentCents: 12_000,
      priorCents: 10_000,
      deltaCents: 2_000,
      changePercent: 20,
    });
  });

  it('returns null percent change against a zero baseline', () => {
    expect(comparePeriods(5_000, 0).changePercent).toBeNull();
  });

  it('reports a negative delta', () => {
    const c = comparePeriods(4_000, 10_000);
    expect(c.deltaCents).toBe(-6_000);
    expect(c.changePercent).toBe(-60);
  });
});
