import { marginPercent } from './margin';

/**
 * Menu Engineering — pure classification, no I/O, no AI (Sprint 5, AI margin roadmap).
 *
 * Classic Kasavana–Smith menu engineering: rank each SOLD item on two deterministic
 * axes and drop it into one of four quadrants so the manager knows what to do with it.
 *
 *   | Class     | Popularity | Profitability | Action              |
 *   | --------- | ---------- | ------------- | ------------------- |
 *   | star      | high       | high          | keep / promote      |
 *   | puzzle    | low        | high          | improve visibility  |
 *   | workhorse | high       | low           | reprice / cut cost  |
 *   | dog       | low        | low           | remove / reformulate|
 *
 * Both thresholds are RELATIVE to the org's own sales in the period, never a global
 * magic number (plan §10): an item is "high popularity" when it sold at or above the
 * average units per item, and "high profitability" when its per-unit contribution
 * margin (price − cost) is at or above the average. Contribution margin in CENTS — not
 * margin % — is the profitability axis on purpose: a €0.40-margin coffee sold 500× and
 * an €9 steak sold 40× must not both read as "star" just because the coffee's *percent*
 * is high. Percent is exposed for display only.
 *
 * Honesty rules this module must never break (plan §10 acceptance), mirroring the
 * Profit Leak Detector: an item with no selling price, or whose cost is unavailable
 * (an unpriced ingredient / an incomplete menu → the loader passes `costCents: null`),
 * is NEVER given a fabricated margin. It is set aside as "needs pricing" and excluded
 * from the averages, so one un-costed item can't skew every other item's quadrant.
 *
 * Money is integer cents. Inputs are normalized domain shapes (not DB rows); the loader
 * resolves current cost/price + posted-sale units so this module stays unit-testable.
 */

export type MenuEngineeringClass = 'star' | 'puzzle' | 'workhorse' | 'dog';

export type MenuEngineeringItemKind = 'recipe' | 'menu';

/** Why an item can't be classified — surfaced so the manager can fix the gap. */
export type MenuEngineeringNeedsPricingReason =
  | 'MISSING_SELLING_PRICE'
  | 'MISSING_COST';

/** One sold catalogue item fed to {@link classifyMenuItems}. */
export type MenuEngineeringInputItem = {
  kind: MenuEngineeringItemKind;
  id: string;
  name: string;
  /** Units sold in the period (posted, non-void) — integer ≥ 1. */
  unitsSold: number;
  /** Current per-unit selling price (cents), or null/≤0 when unpriced. */
  sellingPriceCents: number | null;
  /** Current per-unit cost (cents), or null when unavailable (unpriced ing / incomplete menu). */
  costCents: number | null;
};

export type ClassifiedMenuItem = {
  kind: MenuEngineeringItemKind;
  id: string;
  name: string;
  unitsSold: number;
  sellingPriceCents: number;
  costCents: number;
  /** Per-unit contribution margin = price − cost (can be negative when underpriced). */
  contributionMarginCents: number;
  /** Per-unit margin %, one decimal — display only, never the classification axis. */
  marginPercent: number;
  /** Share of the classified units total (0..1) — display only. */
  popularityShare: number;
  highPopularity: boolean;
  highProfitability: boolean;
  class: MenuEngineeringClass;
};

export type NeedsPricingMenuItem = {
  kind: MenuEngineeringItemKind;
  id: string;
  name: string;
  unitsSold: number;
  reason: MenuEngineeringNeedsPricingReason;
};

export type MenuEngineeringResult = {
  /** Classified items, sorted star→puzzle→workhorse→dog, then units desc, then name. */
  classified: ClassifiedMenuItem[];
  /** Sold-but-un-costed items, sorted units desc then name. Excluded from the averages. */
  needsPricing: NeedsPricingMenuItem[];
  /** Total units across CLASSIFIED items only (the popularity denominator). */
  totalUnitsSold: number;
  /** Popularity split point = classified units / classified count (0 when none). */
  averageUnitsSold: number;
  /** Profitability split point = mean per-unit contribution margin, cents (0 when none). */
  averageContributionMarginCents: number;
  counts: Record<MenuEngineeringClass, number>;
};

/** Fixed order for a deterministic list under the 2×2 matrix. */
const CLASS_RANK: Record<MenuEngineeringClass, number> = {
  star: 0,
  puzzle: 1,
  workhorse: 2,
  dog: 3,
};

function classify(highPopularity: boolean, highProfitability: boolean): MenuEngineeringClass {
  if (highProfitability) return highPopularity ? 'star' : 'puzzle';
  return highPopularity ? 'workhorse' : 'dog';
}

/**
 * Classify a period's sold items into the menu-engineering matrix (pure).
 *
 * An item is only classified when it has BOTH a positive selling price and a finite,
 * available cost; everything else goes to `needsPricing` (missing price takes priority
 * over missing cost — pricing the item is the first thing to fix). Averages are taken
 * over classified items only. Thresholds are inclusive (`≥ average` counts as high), so
 * a lone classified item is trivially a star.
 */
export function classifyMenuItems(
  items: MenuEngineeringInputItem[],
): MenuEngineeringResult {
  const needsPricing: NeedsPricingMenuItem[] = [];
  const costed: {
    item: MenuEngineeringInputItem;
    sellingPriceCents: number;
    costCents: number;
    contributionMarginCents: number;
  }[] = [];

  for (const item of items) {
    const price = item.sellingPriceCents;
    if (price == null || price <= 0 || !Number.isFinite(price)) {
      needsPricing.push({
        kind: item.kind,
        id: item.id,
        name: item.name,
        unitsSold: item.unitsSold,
        reason: 'MISSING_SELLING_PRICE',
      });
      continue;
    }
    const cost = item.costCents;
    if (cost == null || !Number.isFinite(cost)) {
      needsPricing.push({
        kind: item.kind,
        id: item.id,
        name: item.name,
        unitsSold: item.unitsSold,
        reason: 'MISSING_COST',
      });
      continue;
    }
    costed.push({
      item,
      sellingPriceCents: price,
      costCents: cost,
      contributionMarginCents: price - cost,
    });
  }

  const totalUnitsSold = costed.reduce((sum, c) => sum + c.item.unitsSold, 0);
  const count = costed.length;
  const averageUnitsSold = count === 0 ? 0 : totalUnitsSold / count;
  const averageContributionMarginCents =
    count === 0
      ? 0
      : costed.reduce((sum, c) => sum + c.contributionMarginCents, 0) / count;

  const classified: ClassifiedMenuItem[] = costed.map((c) => {
    const highPopularity = c.item.unitsSold >= averageUnitsSold;
    const highProfitability =
      c.contributionMarginCents >= averageContributionMarginCents;
    return {
      kind: c.item.kind,
      id: c.item.id,
      name: c.item.name,
      unitsSold: c.item.unitsSold,
      sellingPriceCents: c.sellingPriceCents,
      costCents: c.costCents,
      contributionMarginCents: c.contributionMarginCents,
      marginPercent: marginPercent(c.costCents, c.sellingPriceCents),
      popularityShare: totalUnitsSold === 0 ? 0 : c.item.unitsSold / totalUnitsSold,
      highPopularity,
      highProfitability,
      class: classify(highPopularity, highProfitability),
    };
  });

  classified.sort(
    (a, b) =>
      CLASS_RANK[a.class] - CLASS_RANK[b.class] ||
      b.unitsSold - a.unitsSold ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  needsPricing.sort(
    (a, b) =>
      b.unitsSold - a.unitsSold ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

  const counts: Record<MenuEngineeringClass, number> = {
    star: 0,
    puzzle: 0,
    workhorse: 0,
    dog: 0,
  };
  for (const item of classified) counts[item.class] += 1;

  return {
    classified,
    needsPricing,
    totalUnitsSold,
    averageUnitsSold,
    averageContributionMarginCents,
    counts,
  };
}
