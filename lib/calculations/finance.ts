/**
 * Financial aggregates — pure functions, no I/O (like lib/calculations/dashboard.ts).
 * Operate on plain transaction rows the data layer already filtered/scoped, so
 * they are DB-agnostic and trivially testable.
 *
 * Money is integer cents. `amountCents` is a POSITIVE magnitude; direction comes
 * from `type` (income vs expense). Profit = income − expense (may be negative).
 * Dates are bare 'YYYY-MM-DD' strings: monthly/annual buckets slice the string,
 * so there is zero timezone math.
 */

export type FinanceKind = 'income' | 'expense';

/** The minimal shape the aggregates need from a transaction. */
export type FinanceTxn = {
  type: FinanceKind;
  /** Positive integer cents. */
  amountCents: number;
  /** 'YYYY-MM-DD'. */
  occurredOn: string;
  category: { id: string; slug: string | null; name: string; kind: FinanceKind };
  /** Linked recipe (income only powers "top products"); null is valid. */
  recipe: { id: string; name: string } | null;
};

export type CategoryTotal = {
  categoryId: string;
  slug: string | null;
  name: string;
  kind: FinanceKind;
  totalCents: number;
};

export type ProductTotal = {
  recipeId: string;
  name: string;
  totalCents: number;
};

export type FinanceSummary = {
  incomeCents: number;
  expenseCents: number;
  /** income − expense (negative when the org ran at a loss). */
  profitCents: number;
  /** Every category with activity, highest total first. */
  byCategory: CategoryTotal[];
  /** Income grouped by linked recipe, highest first, capped at `topN`. */
  topProducts: ProductTotal[];
};

/**
 * Totals, by-category breakdown, and top products for the given transactions.
 * Whatever period/filter the caller wants is applied BEFORE calling this.
 */
export function financeSummary(txns: FinanceTxn[], topN = 5): FinanceSummary {
  let incomeCents = 0;
  let expenseCents = 0;
  const byCategoryMap = new Map<string, CategoryTotal>();
  const byProductMap = new Map<string, ProductTotal>();

  for (const t of txns) {
    if (t.type === 'income') incomeCents += t.amountCents;
    else expenseCents += t.amountCents;

    const existing = byCategoryMap.get(t.category.id);
    if (existing) {
      existing.totalCents += t.amountCents;
    } else {
      byCategoryMap.set(t.category.id, {
        categoryId: t.category.id,
        slug: t.category.slug,
        name: t.category.name,
        kind: t.category.kind,
        totalCents: t.amountCents,
      });
    }

    if (t.type === 'income' && t.recipe) {
      const product = byProductMap.get(t.recipe.id);
      if (product) {
        product.totalCents += t.amountCents;
      } else {
        byProductMap.set(t.recipe.id, {
          recipeId: t.recipe.id,
          name: t.recipe.name,
          totalCents: t.amountCents,
        });
      }
    }
  }

  const byCategory = [...byCategoryMap.values()].sort(
    (a, b) => b.totalCents - a.totalCents,
  );
  const topProducts = [...byProductMap.values()]
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, topN);

  return {
    incomeCents,
    expenseCents,
    profitCents: incomeCents - expenseCents,
    byCategory,
    topProducts,
  };
}

export type MonthlyBucket = {
  /** 1–12. */
  month: number;
  incomeCents: number;
  expenseCents: number;
  profitCents: number;
};

/**
 * Twelve income/expense/profit buckets for one calendar year, keyed off the bare
 * date string (no tz). Months with no activity stay zeroed (an honest flat line).
 */
export function monthlyBuckets(txns: FinanceTxn[], year: number): MonthlyBucket[] {
  const buckets: MonthlyBucket[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    incomeCents: 0,
    expenseCents: 0,
    profitCents: 0,
  }));

  const yearPrefix = String(year);
  for (const t of txns) {
    if (t.occurredOn.slice(0, 4) !== yearPrefix) continue;
    const monthIndex = Number(t.occurredOn.slice(5, 7)) - 1;
    if (monthIndex < 0 || monthIndex > 11) continue;
    const bucket = buckets[monthIndex]!;
    if (t.type === 'income') bucket.incomeCents += t.amountCents;
    else bucket.expenseCents += t.amountCents;
    bucket.profitCents = bucket.incomeCents - bucket.expenseCents;
  }

  return buckets;
}

/**
 * Running total of profit across the year's buckets — month-by-month cumulative
 * cash flow (`result[i]` = Σ profit of months 0..i). Pure; the caller decides how
 * to trim trailing empty months for display.
 */
export function cumulativeProfit(buckets: MonthlyBucket[]): number[] {
  let running = 0;
  return buckets.map((b) => {
    running += b.profitCents;
    return running;
  });
}

export type PeriodComparison = {
  currentCents: number;
  priorCents: number;
  deltaCents: number;
  /** Percent change vs the prior period; null when prior is 0 (no baseline). */
  changePercent: number | null;
};

/**
 * Compares a current total against a prior period. Percent change uses the
 * magnitude of the prior value so the sign reflects the delta direction; a zero
 * baseline yields `null` (a percentage would be meaningless / infinite).
 */
export function comparePeriods(
  currentCents: number,
  priorCents: number,
): PeriodComparison {
  const deltaCents = currentCents - priorCents;
  const changePercent =
    priorCents === 0
      ? null
      : Math.round((deltaCents / Math.abs(priorCents)) * 1000) / 10;
  return { currentCents, priorCents, deltaCents, changePercent };
}
