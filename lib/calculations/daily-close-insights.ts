import { marginPercent, MARGIN_THRESHOLDS } from './margin';

/**
 * Daily Close Insights — pure fact derivation, no I/O, no AI (Sprint 6, AI margin
 * roadmap).
 *
 * After a daily close is POSTED, PrepProfit explains what happened. The whole safety
 * contract (plan §11, CLAUDE.md §AI): every money figure is computed HERE, deterministically,
 * from the frozen sale totals + the org's CURRENT catalogue cost. The AI layer that runs
 * next only *summarizes* this fact set in prose — it never calculates food cost, and it
 * never sees a number this module did not produce.
 *
 * Honesty rules, mirroring the Profit Leak Detector and Menu Engineer:
 *   - A sold line whose cost is UNAVAILABLE (an unpriced ingredient, an incomplete menu,
 *     an unpriced direct-ingredient line → the loader passes `unitCostCents: null`) is
 *     NEVER given a fabricated cost. It is set aside in `missingCostItems`, excluded from
 *     the food-cost total, and flips `costComplete` to false so the summary can say the
 *     figure is partial.
 *   - Food cost % is taken over NET (ex-tax) revenue — the restaurant convention — and is
 *     null when there is no net revenue or no costed line.
 *   - Variance vs comparable days is only reported when enough history exists
 *     (`minHistoryForVariance`); otherwise it is null (never a variance off one data point).
 *
 * Money is integer cents. Inputs are normalized domain shapes (not DB rows); the loader
 * resolves the frozen close totals, current per-unit cost, and comparable-day history so
 * this module stays unit-testable.
 */

export type DailyCloseItemKind = 'recipe' | 'menu' | 'ingredient';

/** One posted sale line fed to {@link buildDailyCloseInsights}. */
export type DailyCloseLineInput = {
  kind: DailyCloseItemKind;
  /** The recipe/menu/ingredient id (frozen on the line). */
  id: string;
  /** The frozen item name as sold. */
  name: string;
  /** Units sold on this close (integer ≥ 1). */
  unitsSold: number;
  /** Frozen NET revenue for the whole line (quantity × unit net), integer cents. */
  netCents: number;
  /** Current per-unit cost (cents), or null when unavailable (unpriced / incomplete). */
  unitCostCents: number | null;
};

export type DailyCloseInsightsInput = {
  /** 'YYYY-MM-DD' of the close being explained. */
  saleDate: string;
  /** Frozen sale totals (tax.ts, per-line-then-sum). */
  grossCents: number;
  netCents: number;
  taxCents: number;
  lines: DailyCloseLineInput[];
  /**
   * Gross takings of the PRIOR comparable posted closes, newest-first, for the variance
   * baseline. Empty (or shorter than `minHistoryForVariance`) → no variance reported.
   */
  comparableGrossCents: number[];
  /** Below this margin %, a costed seller is "low margin". Defaults to green (65%). */
  targetMarginPercent?: number;
  /** How many top sellers to surface. Defaults to 3. */
  topSellersLimit?: number;
  /** Minimum comparable days before a variance is reported. Defaults to 3. */
  minHistoryForVariance?: number;
  /** |change%| at/above which the variance is flagged `unusual`. Defaults to 30. */
  unusualVariancePercent?: number;
};

export type DailyCloseSeller = {
  kind: DailyCloseItemKind;
  id: string;
  name: string;
  unitsSold: number;
  netCents: number;
};

export type DailyCloseLowMarginSeller = {
  kind: DailyCloseItemKind;
  id: string;
  name: string;
  unitsSold: number;
  /** Per-unit gross margin %, one decimal. */
  marginPercent: number;
  /** Per-unit contribution margin = net price − cost (cents; can be negative). */
  contributionMarginCents: number;
};

export type DailyCloseMissingCostItem = {
  kind: DailyCloseItemKind;
  id: string;
  name: string;
  unitsSold: number;
};

export type DailyCloseVariance = {
  /** Mean gross of the comparable prior closes, cents (rounded). */
  baselineAvgGrossCents: number;
  /** How many comparable closes fed the baseline. */
  sampleSize: number;
  /** (today − baseline) / baseline × 100, one decimal. */
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
  /** True when |changePercent| ≥ the unusual threshold. */
  unusual: boolean;
};

export type DailyCloseInsights = {
  saleDate: string;
  grossSalesCents: number;
  netSalesCents: number;
  taxCents: number;
  /** Distinct sold items on the close. */
  itemCount: number;
  /** Total units across all sold lines. */
  unitsSold: number;
  /** Sum of costed lines' cost (cents), or null when NO line had a cost. */
  estimatedFoodCostCents: number | null;
  /** estimatedFoodCost / net × 100, one decimal — null when net ≤ 0 or no costed line. */
  foodCostPercent: number | null;
  /** True when every sold line resolved to a cost (nothing in `missingCostItems`). */
  costComplete: boolean;
  targetMarginPercent: number;
  topSellers: DailyCloseSeller[];
  lowMarginSellers: DailyCloseLowMarginSeller[];
  missingCostItems: DailyCloseMissingCostItem[];
  /** Variance vs comparable days, or null when not enough history. */
  variance: DailyCloseVariance | null;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Distil a posted close into its deterministic fact set (pure). Every figure comes from
 * the frozen totals or the current catalogue cost the loader resolved; nothing is
 * invented. A line with a null/non-finite `unitCostCents` is treated as un-costed
 * (listed in `missingCostItems`, excluded from the food-cost total).
 */
export function buildDailyCloseInsights(
  input: DailyCloseInsightsInput,
): DailyCloseInsights {
  const target = input.targetMarginPercent ?? MARGIN_THRESHOLDS.green;
  const topLimit = input.topSellersLimit ?? 3;
  const minHistory = input.minHistoryForVariance ?? 3;
  const unusualThreshold = input.unusualVariancePercent ?? 30;

  const unitsSold = input.lines.reduce((sum, l) => sum + l.unitsSold, 0);

  // ── Food cost: sum costed lines only; the rest are set aside (never fabricated). ──
  const missingCostItems: DailyCloseMissingCostItem[] = [];
  let costedFoodCostCents = 0;
  let anyCosted = false;

  const lowMarginSellers: DailyCloseLowMarginSeller[] = [];

  for (const line of input.lines) {
    const cost = line.unitCostCents;
    if (cost == null || !Number.isFinite(cost)) {
      missingCostItems.push({
        kind: line.kind,
        id: line.id,
        name: line.name,
        unitsSold: line.unitsSold,
      });
      continue;
    }
    anyCosted = true;
    costedFoodCostCents += cost * line.unitsSold;

    // Per-unit margin from the frozen net price vs the current unit cost.
    const perUnitNet = line.unitsSold > 0 ? line.netCents / line.unitsSold : 0;
    const margin = marginPercent(cost, perUnitNet);
    if (perUnitNet > 0 && margin < target) {
      lowMarginSellers.push({
        kind: line.kind,
        id: line.id,
        name: line.name,
        unitsSold: line.unitsSold,
        marginPercent: margin,
        contributionMarginCents: Math.round(perUnitNet) - cost,
      });
    }
  }

  const estimatedFoodCostCents = anyCosted ? Math.round(costedFoodCostCents) : null;
  const foodCostPercent =
    estimatedFoodCostCents != null && input.netCents > 0
      ? round1((estimatedFoodCostCents / input.netCents) * 100)
      : null;

  // ── Top sellers: units desc, then net desc, then name, then id (deterministic). ──
  const topSellers: DailyCloseSeller[] = input.lines
    .map((l) => ({
      kind: l.kind,
      id: l.id,
      name: l.name,
      unitsSold: l.unitsSold,
      netCents: l.netCents,
    }))
    .sort(
      (a, b) =>
        b.unitsSold - a.unitsSold ||
        b.netCents - a.netCents ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(0, topLimit));

  // Worst margin first — the sellers most worth a manager's attention.
  lowMarginSellers.sort(
    (a, b) =>
      a.marginPercent - b.marginPercent ||
      b.unitsSold - a.unitsSold ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  // ── Variance vs comparable days (only with enough history). ──
  let variance: DailyCloseVariance | null = null;
  const sample = input.comparableGrossCents.filter((v) => Number.isFinite(v));
  if (sample.length >= minHistory) {
    const baselineAvgGrossCents = Math.round(
      sample.reduce((sum, v) => sum + v, 0) / sample.length,
    );
    if (baselineAvgGrossCents > 0) {
      const changePercent = round1(
        ((input.grossCents - baselineAvgGrossCents) / baselineAvgGrossCents) * 100,
      );
      const direction: DailyCloseVariance['direction'] =
        changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'flat';
      variance = {
        baselineAvgGrossCents,
        sampleSize: sample.length,
        changePercent,
        direction,
        unusual: Math.abs(changePercent) >= unusualThreshold,
      };
    }
  }

  return {
    saleDate: input.saleDate,
    grossSalesCents: input.grossCents,
    netSalesCents: input.netCents,
    taxCents: input.taxCents,
    itemCount: input.lines.length,
    unitsSold,
    estimatedFoodCostCents,
    foodCostPercent,
    costComplete: missingCostItems.length === 0,
    targetMarginPercent: target,
    topSellers,
    lowMarginSellers,
    missingCostItems,
    variance,
  };
}
