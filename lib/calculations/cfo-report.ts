import { MARGIN_THRESHOLDS } from './margin';
import type { Dimension } from '@/lib/units';
import type { ProfitLeakFinding } from './profit-leaks';

/**
 * Weekly CFO Report — pure fact assembly, no I/O, no AI (Sprint 8, AI margin roadmap;
 * plan §13). The premium management layer over the trusted deterministic insight modules.
 *
 * The whole safety contract (CLAUDE.md §AI, plan §13 acceptance): every figure here is
 * derived deterministically from data PrepProfit already computed — the frozen weekly sale
 * totals, the org's CURRENT catalogue cost (via the same `recipeCost`/`menuCost` engine the
 * Profit Leak Detector and Menu Engineer use), pending supplier price observations, and the
 * stock ledger. The AI layer that runs next only *narrates* this report; it never calculates
 * a trend or invents a number.
 *
 * Honesty rules, mirroring the other margin modules:
 *   - A trend is only reported when both sides have a usable baseline; otherwise it is null
 *     and a confidence note is emitted (never a percentage off a zero baseline).
 *   - Food cost is taken over NET (ex-tax) revenue — the restaurant convention — and is null
 *     when a week has no net revenue or no costed line; a partial week (some sold items had
 *     no resolvable cost) flips `costComplete` false so the report says the figure is partial.
 *   - Margin leaks and reprice candidates come straight off the deterministic detector
 *     ({@link ProfitLeakFinding}); an unpriced/incomplete item is a data-gap note, never a
 *     fabricated margin.
 *
 * Money is integer cents. Inputs are normalized domain shapes (not DB rows); the loader
 * resolves the weekly totals, current catalogue leaks, price observations, and stock, so this
 * module stays unit-testable.
 */

/** Frozen + currently-costed totals for one week window. */
export type CfoWeeklyTotals = {
  /** Sum of posted-close gross takings in the week, integer cents. */
  grossCents: number;
  /** Sum of posted-close NET (ex-tax) revenue in the week, integer cents. */
  netCents: number;
  /**
   * Sum of every sold line's CURRENT unit cost × units, over the costed lines only, integer
   * cents — or null when no sold line in the week had a resolvable cost.
   */
  foodCostCents: number | null;
  /** False when some sold lines had no cost, so `foodCostCents` is a PARTIAL figure. */
  costComplete: boolean;
  /** Distinct posted closes in the week (0 → the week had no sales). */
  closeCount: number;
};

/** A pending supplier price observation that differs from the approved price. */
export type CfoSupplierPriceChange = {
  ingredientId: string;
  name: string;
  /** The currently-approved price per priced unit, cents. */
  fromCents: number;
  /** The pending observed price per priced unit, cents (from the invoice reader). */
  toCents: number;
};

/** An active ingredient at/below its low-stock threshold (a reorder anomaly). */
export type CfoLowStockItem = {
  ingredientId: string;
  name: string;
  dimension: Dimension;
  onHandCanonical: number;
  thresholdCanonical: number;
};

export type CfoReportInput = {
  /** Inclusive week window, bare 'YYYY-MM-DD'. */
  weekFrom: string;
  weekTo: string;
  thisWeek: CfoWeeklyTotals;
  priorWeek: CfoWeeklyTotals;
  /** Deterministic catalogue findings, already severity-sorted by the detector. */
  marginLeaks: ProfitLeakFinding[];
  supplierPriceChanges: CfoSupplierPriceChange[];
  lowStock: CfoLowStockItem[];
  /** Active needs-pricing ingredients referenced by ≥1 recipe/menu (confidence gap). */
  unpricedIngredientCount: number;
  /** Active menus that cannot be fully costed (a trashed/missing component). */
  incompleteMenuCount: number;
  /** Below this margin %, a sold item is a reprice candidate. Defaults to green (65%). */
  targetMarginPercent?: number;
  /** How many top margin leaks to surface. Defaults to 8. */
  topLeaksLimit?: number;
  /** How many reprice candidates to surface. Defaults to 8. */
  topRepriceLimit?: number;
  /** How many supplier price changes to surface. Defaults to 8. */
  topPriceChangesLimit?: number;
  /** How many low-stock items to surface. Defaults to 8. */
  topLowStockLimit?: number;
};

/** For revenue, UP is good; for food cost, DOWN is good. Direction is just the sign. */
export type CfoTrendDirection = 'up' | 'down' | 'flat';

export type CfoRevenueTrend = {
  thisWeekGrossCents: number;
  priorWeekGrossCents: number;
  thisWeekNetCents: number;
  priorWeekNetCents: number;
  /** Gross change % vs prior week, one decimal; null when there is no prior baseline. */
  changePercent: number | null;
  direction: CfoTrendDirection;
};

export type CfoFoodCostTrend = {
  /** thisWeek food cost / net × 100, one decimal — null when not computable. */
  thisWeekPercent: number | null;
  priorWeekPercent: number | null;
  /** thisWeek − priorWeek, in percentage POINTS, one decimal; null when either side missing. */
  changePoints: number | null;
  /** Sign of `changePoints` (a rising food-cost % is `up` and is the bad direction). */
  direction: CfoTrendDirection;
  /** False when this week's food cost is partial (some sold items were un-costed). */
  thisWeekComplete: boolean;
};

export type CfoRepriceCandidate = {
  entityType: 'recipe' | 'menu';
  entityId: string;
  entityName: string;
  currentMarginPercent: number;
  targetMarginPercent: number;
  currentCostCents: number;
  suggestedPriceCents: number | null;
};

export type CfoSupplierPriceChangeOut = CfoSupplierPriceChange & {
  /** (to − from) / from × 100, one decimal; null when the approved price is 0. */
  changePercent: number | null;
  direction: 'up' | 'down';
};

/** Machine codes for why the report's confidence is limited (localized client-side). */
export type CfoConfidenceCode =
  | 'NO_SALES_THIS_WEEK'
  | 'NO_PRIOR_WEEK_BASELINE'
  | 'PARTIAL_FOOD_COST'
  | 'UNPRICED_INGREDIENTS'
  | 'INCOMPLETE_MENUS';

export type CfoConfidenceNote = {
  code: CfoConfidenceCode;
  /** A magnitude for the note (e.g. how many unpriced ingredients); 0 when not applicable. */
  count: number;
};

export type CfoReport = {
  weekFrom: string;
  weekTo: string;
  targetMarginPercent: number;
  revenue: CfoRevenueTrend;
  foodCost: CfoFoodCostTrend;
  /** Top leaks by severity (already sorted, trimmed to the limit). */
  marginLeaks: ProfitLeakFinding[];
  /** Below-target sold items with a suggested price, trimmed to the limit. */
  repriceCandidates: CfoRepriceCandidate[];
  /** Biggest pending supplier price moves, largest absolute change first. */
  supplierPriceChanges: CfoSupplierPriceChangeOut[];
  /** Ingredients at/below their reorder threshold, most depleted first. */
  lowStock: CfoLowStockItem[];
  confidence: CfoConfidenceNote[];
  /** True when there is genuinely something to report (sales, leaks, changes, or low stock). */
  hasData: boolean;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Food cost % over net, one decimal; null when net ≤ 0 or the food cost is absent. */
function foodCostPercent(totals: CfoWeeklyTotals): number | null {
  if (totals.foodCostCents == null || totals.netCents <= 0) return null;
  return round1((totals.foodCostCents / totals.netCents) * 100);
}

function directionOf(delta: number): CfoTrendDirection {
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
}

/**
 * Assemble the deterministic weekly CFO report (pure). Every figure comes from the loader's
 * resolved weekly totals or the catalogue findings; nothing is invented. Trends are null (and
 * a confidence note is emitted) when a baseline is missing, so a percentage is never reported
 * off a zero denominator.
 */
export function buildCfoReport(input: CfoReportInput): CfoReport {
  const target = input.targetMarginPercent ?? MARGIN_THRESHOLDS.green;
  const topLeaks = input.topLeaksLimit ?? 8;
  const topReprice = input.topRepriceLimit ?? 8;
  const topPriceChanges = input.topPriceChangesLimit ?? 8;
  const topLowStock = input.topLowStockLimit ?? 8;

  // ── Revenue trend (gross vs prior week; null when no prior baseline). ──
  const priorGross = input.priorWeek.grossCents;
  const revenueChangePercent =
    input.priorWeek.closeCount > 0 && priorGross > 0
      ? round1(((input.thisWeek.grossCents - priorGross) / priorGross) * 100)
      : null;
  const revenue: CfoRevenueTrend = {
    thisWeekGrossCents: input.thisWeek.grossCents,
    priorWeekGrossCents: input.priorWeek.grossCents,
    thisWeekNetCents: input.thisWeek.netCents,
    priorWeekNetCents: input.priorWeek.netCents,
    changePercent: revenueChangePercent,
    direction: revenueChangePercent == null ? 'flat' : directionOf(revenueChangePercent),
  };

  // ── Food cost trend (percentage points; null when either week isn't computable). ──
  const thisFoodPct = foodCostPercent(input.thisWeek);
  const priorFoodPct = foodCostPercent(input.priorWeek);
  const changePoints =
    thisFoodPct != null && priorFoodPct != null
      ? round1(thisFoodPct - priorFoodPct)
      : null;
  const foodCost: CfoFoodCostTrend = {
    thisWeekPercent: thisFoodPct,
    priorWeekPercent: priorFoodPct,
    changePoints,
    direction: changePoints == null ? 'flat' : directionOf(changePoints),
    thisWeekComplete: input.thisWeek.costComplete,
  };

  // ── Margin leaks + reprice candidates (from the deterministic detector). ──
  const marginLeaks = input.marginLeaks.slice(0, topLeaks);
  const repriceCandidates: CfoRepriceCandidate[] = input.marginLeaks
    .filter(
      (f) =>
        (f.type === 'RECIPE_BELOW_TARGET_MARGIN' ||
          f.type === 'MENU_BELOW_TARGET_MARGIN') &&
        f.currentMarginPercent != null &&
        f.currentCostCents != null,
    )
    .slice(0, topReprice)
    .map((f) => ({
      entityType: f.entityType === 'menu' ? 'menu' : 'recipe',
      entityId: f.entityId,
      entityName: f.entityName,
      currentMarginPercent: f.currentMarginPercent as number,
      targetMarginPercent: f.targetMarginPercent ?? target,
      currentCostCents: f.currentCostCents as number,
      suggestedPriceCents: f.suggestedPriceCents,
    }));

  // ── Supplier price changes (largest absolute move first; drop no-op equals). ──
  const supplierPriceChanges: CfoSupplierPriceChangeOut[] = input.supplierPriceChanges
    .filter((c) => c.toCents !== c.fromCents)
    .map((c) => ({
      ...c,
      changePercent:
        c.fromCents > 0 ? round1(((c.toCents - c.fromCents) / c.fromCents) * 100) : null,
      direction: c.toCents > c.fromCents ? ('up' as const) : ('down' as const),
    }))
    .sort(
      (a, b) =>
        Math.abs(b.toCents - b.fromCents) - Math.abs(a.toCents - a.fromCents) ||
        a.name.localeCompare(b.name) ||
        a.ingredientId.localeCompare(b.ingredientId),
    )
    .slice(0, topPriceChanges);

  // ── Low stock (most depleted first — smallest on-hand ÷ threshold ratio). ──
  const lowStock = [...input.lowStock]
    .sort(
      (a, b) =>
        a.onHandCanonical / a.thresholdCanonical -
          b.onHandCanonical / b.thresholdCanonical ||
        a.name.localeCompare(b.name) ||
        a.ingredientId.localeCompare(b.ingredientId),
    )
    .slice(0, topLowStock);

  // ── Confidence notes (explicit about what limits the report). ──
  const confidence: CfoConfidenceNote[] = [];
  if (input.thisWeek.closeCount === 0) {
    confidence.push({ code: 'NO_SALES_THIS_WEEK', count: 0 });
  }
  if (input.priorWeek.closeCount === 0) {
    confidence.push({ code: 'NO_PRIOR_WEEK_BASELINE', count: 0 });
  }
  if (input.thisWeek.closeCount > 0 && !input.thisWeek.costComplete) {
    confidence.push({ code: 'PARTIAL_FOOD_COST', count: 0 });
  }
  if (input.unpricedIngredientCount > 0) {
    confidence.push({ code: 'UNPRICED_INGREDIENTS', count: input.unpricedIngredientCount });
  }
  if (input.incompleteMenuCount > 0) {
    confidence.push({ code: 'INCOMPLETE_MENUS', count: input.incompleteMenuCount });
  }

  const hasData =
    input.thisWeek.closeCount > 0 ||
    marginLeaks.length > 0 ||
    supplierPriceChanges.length > 0 ||
    lowStock.length > 0;

  return {
    weekFrom: input.weekFrom,
    weekTo: input.weekTo,
    targetMarginPercent: target,
    revenue,
    foodCost,
    marginLeaks,
    repriceCandidates,
    supplierPriceChanges,
    lowStock,
    confidence,
    hasData,
  };
}
