/**
 * Hour Engine — pure profit-per-production-hour maths for the Profit section.
 * No I/O. Money is integer cents in and out; fractions survive internally and are
 * rounded ONCE at the output boundary (like `recipeCost`). Every function guards
 * against zero/negative/NaN/Infinity inputs and returns `null` rather than a
 * flattering number.
 *
 * Products are judged by €/hour of hands-on production time, not margin %, because
 * margin hides the biggest cost: time.
 *
 *   fixed_cost_per_hour    = total_monthly_fixed_costs ÷ productive_hours_per_month
 *   TRUE_HOURLY_RATE       = fixed_cost_per_hour + owner_target_income_per_hour
 *
 *   variable_cost_per_unit = ingredient × multiplier × (1 + waste) + packaging
 *                            + energy_per_batch ÷ yield + delivery_per_unit
 *   time_per_unit          = batch_time ÷ yield
 *   floor_price            = variable_cost_per_unit + time_per_unit × TRUE_HOURLY_RATE
 *   margin_pct             = (price − ingredient) ÷ price
 *   euro_per_hour          = (price − variable_cost_per_unit) ÷ time_per_unit
 *   units_per_hour         = yield ÷ batch_time
 *   discount_room          = price − floor_price
 *
 * Note: `price < floor_price` is mathematically the same statement as
 * `euro_per_hour < TRUE_HOURLY_RATE`. The verdict bands therefore split the
 * below-floor zone by whether the product still covers the FIXED-cost part of the
 * hour (`fragile`) or not even that (`losing`).
 */

export const FIXED_COST_KEYS = [
  'rent',
  'equipmentLeases',
  'equipmentDepreciation',
  'insuranceLicenses',
  'utilities',
  'salariedStaff',
  'software',
] as const;
export type FixedCostKey = (typeof FIXED_COST_KEYS)[number];
export type FixedCostsCents = Record<FixedCostKey, number>;

/** Default product waste when none is set: 5%. */
export const DEFAULT_WASTE_BPS = 500;
/** Default sublet ingredient multiplier: 1.4×. */
export const DEFAULT_SUBLET_MULTIPLIER_BPS = 14_000;
/** €/hour at or above this multiple of the true rate is a Hero. */
export const HERO_RATE_MULTIPLE = 1.25;
/** Ingredient margin at or above this is "high". */
export const HIGH_MARGIN_BPS = 7_000;
/** Ingredient margin below this is "low". */
export const LOW_MARGIN_BPS = 6_000;

const MINUTES_PER_HOUR = 60;
const BPS = 10_000;

const finite = (n: number): boolean => Number.isFinite(n);
const nonNegative = (n: number): number => (finite(n) && n > 0 ? n : 0);

// ── Part A — True Hourly Rate ──────────────────────────────────────────────────

export type HourlyRateInput = {
  fixedCostsCents: FixedCostsCents;
  productiveHoursPerMonth: number;
  ownerTargetIncomePerHourCents: number;
  /** Sublet kitchen: rent leaves fixed costs, ingredients carry a multiplier. */
  subletEnabled: boolean;
  subletIngredientMultiplierBps: number;
};

export type HourlyRate = {
  totalMonthlyFixedCostsCents: number;
  fixedCostPerHourCents: number;
  ownerTargetIncomePerHourCents: number;
  trueHourlyRateCents: number;
  /** Multiplier applied to ingredient cost (10000 = none). */
  ingredientMultiplierBps: number;
};

/** Monthly straight-line depreciation: purchase ÷ years ÷ 12. Null when not computable. */
export function monthlyDepreciationCents(
  purchasePriceCents: number,
  years: number,
): number | null {
  if (!finite(purchasePriceCents) || purchasePriceCents < 0) return null;
  if (!finite(years) || years <= 0) return null;
  return Math.round(purchasePriceCents / years / 12);
}

export function trueHourlyRate(input: HourlyRateInput): HourlyRate | null {
  const hours = input.productiveHoursPerMonth;
  if (!finite(hours) || hours <= 0) return null;

  const total = FIXED_COST_KEYS.reduce((sum, key) => {
    if (key === 'rent' && input.subletEnabled) return sum;
    return sum + nonNegative(input.fixedCostsCents[key]);
  }, 0);
  const owner = nonNegative(input.ownerTargetIncomePerHourCents);
  const fixedPerHour = total / hours;
  const multiplier =
    input.subletEnabled &&
    finite(input.subletIngredientMultiplierBps) &&
    input.subletIngredientMultiplierBps >= BPS
      ? input.subletIngredientMultiplierBps
      : BPS;

  return {
    totalMonthlyFixedCostsCents: Math.round(total),
    fixedCostPerHourCents: Math.round(fixedPerHour),
    ownerTargetIncomePerHourCents: Math.round(owner),
    trueHourlyRateCents: Math.round(fixedPerHour + owner),
    ingredientMultiplierBps: multiplier,
  };
}

// ── Part B — per-product calculator ───────────────────────────────────────────

export type ProductProfitInput = {
  /** Ingredient cost of one batch (after recipe trim/loss), cents; may be fractional. */
  ingredientCostPerBatchCents: number;
  /** Packaging cost of one batch, cents. */
  packagingPerBatchCents: number;
  /** Energy cost of one batch, cents. */
  energyPerBatchCents: number;
  /** Delivery cost per sold unit, cents. */
  deliveryPerUnitCents: number;
  /** Product waste in basis points (500 = 5%). */
  wasteBps: number;
  /** Hands-on production time for one batch, minutes. */
  batchMinutes: number;
  /** Sellable units one batch yields. */
  batchYield: number;
  /** Selling price per unit, cents. */
  sellingPriceCents: number;
  /** Optional upgrade step (e.g. decoration): extra minutes per unit + extra price. */
  extraStep?: { minutes: number; priceCents: number } | null;
};

export const PRODUCT_FLAGS = [
  'belowFloor',
  'highMarginLowHour',
  'lowMarginStrong',
] as const;
export type ProductFlag = (typeof PRODUCT_FLAGS)[number];

export const VERDICTS = ['hero', 'solid', 'fragile', 'losing'] as const;
export type Verdict = (typeof VERDICTS)[number];

export type ProductProfit = {
  ingredientCostPerUnitCents: number;
  variableCostPerUnitCents: number;
  /** Minutes of hands-on time per unit (not rounded). */
  minutesPerUnit: number;
  unitsPerHour: number;
  /** (price − ingredient) ÷ price in bps; null when the price is 0. */
  marginBps: number | null;
  euroPerHourCents: number;
  /** Rate-dependent — null when no true hourly rate is configured. */
  floorPriceCents: number | null;
  discountRoomCents: number | null;
  verdict: Verdict | null;
  flags: ProductFlag[];
  /** Implied €/hour of the extra step; null when there is no valid step. */
  extraStepRateCents: number | null;
  extraStepBelowRate: boolean;
};

export function verdictFor(euroPerHourCents: number, rate: HourlyRate): Verdict {
  if (euroPerHourCents >= rate.trueHourlyRateCents * HERO_RATE_MULTIPLE) {
    // A zero rate would make every product a hero, including loss-makers.
    return euroPerHourCents > 0 ? 'hero' : 'losing';
  }
  if (euroPerHourCents >= rate.trueHourlyRateCents) return 'solid';
  if (euroPerHourCents >= rate.fixedCostPerHourCents && euroPerHourCents > 0) {
    return 'fragile';
  }
  return 'losing';
}

export function productProfit(
  input: ProductProfitInput,
  rate: HourlyRate | null,
): ProductProfit | null {
  const { batchMinutes, batchYield, sellingPriceCents } = input;
  if (!finite(batchMinutes) || batchMinutes <= 0) return null;
  if (!finite(batchYield) || batchYield <= 0) return null;
  if (!finite(sellingPriceCents) || sellingPriceCents < 0) return null;
  if (!finite(input.ingredientCostPerBatchCents)) return null;

  const multiplier = rate ? rate.ingredientMultiplierBps / BPS : 1;
  const wasteBps = finite(input.wasteBps)
    ? Math.min(Math.max(input.wasteBps, 0), BPS)
    : DEFAULT_WASTE_BPS;

  const ingredientPerUnit = nonNegative(input.ingredientCostPerBatchCents) / batchYield;
  const variablePerUnit =
    ingredientPerUnit * multiplier * (1 + wasteBps / BPS) +
    nonNegative(input.packagingPerBatchCents) / batchYield +
    nonNegative(input.energyPerBatchCents) / batchYield +
    nonNegative(input.deliveryPerUnitCents);

  const minutesPerUnit = batchMinutes / batchYield;
  const hoursPerUnit = minutesPerUnit / MINUTES_PER_HOUR;
  const euroPerHour = (sellingPriceCents - variablePerUnit) / hoursPerUnit;
  const marginBps =
    sellingPriceCents > 0
      ? Math.round(((sellingPriceCents - ingredientPerUnit) / sellingPriceCents) * BPS)
      : null;

  let floorPriceCents: number | null = null;
  let discountRoomCents: number | null = null;
  let verdict: Verdict | null = null;
  const flags: ProductFlag[] = [];
  let extraStepRateCents: number | null = null;
  let extraStepBelowRate = false;

  const step = input.extraStep;
  if (step && finite(step.minutes) && step.minutes > 0 && finite(step.priceCents) && step.priceCents >= 0) {
    extraStepRateCents = Math.round(step.priceCents / (step.minutes / MINUTES_PER_HOUR));
  }

  if (rate) {
    const floor = variablePerUnit + hoursPerUnit * rate.trueHourlyRateCents;
    floorPriceCents = Math.round(floor);
    discountRoomCents = Math.round(sellingPriceCents - floor);
    const euroPerHourCents = Math.round(euroPerHour);
    verdict = verdictFor(euroPerHourCents, rate);

    if (sellingPriceCents < floor) flags.push('belowFloor');
    if (marginBps !== null && marginBps >= HIGH_MARGIN_BPS && euroPerHourCents < rate.trueHourlyRateCents) {
      flags.push('highMarginLowHour');
    }
    if (
      marginBps !== null &&
      marginBps < LOW_MARGIN_BPS &&
      euroPerHourCents >= rate.trueHourlyRateCents * HERO_RATE_MULTIPLE &&
      euroPerHourCents > 0
    ) {
      flags.push('lowMarginStrong');
    }
    if (extraStepRateCents !== null) {
      extraStepBelowRate = extraStepRateCents < rate.trueHourlyRateCents;
    }
  }

  return {
    ingredientCostPerUnitCents: Math.round(ingredientPerUnit),
    variableCostPerUnitCents: Math.round(variablePerUnit),
    minutesPerUnit,
    unitsPerHour: batchYield / (batchMinutes / MINUTES_PER_HOUR),
    marginBps,
    euroPerHourCents: Math.round(euroPerHour),
    floorPriceCents,
    discountRoomCents,
    verdict,
    flags,
    extraStepRateCents,
    extraStepBelowRate,
  };
}

// ── Part C — catalogue ranking ───────────────────────────────────────────────

export type CatalogueProductRow = {
  id: string;
  name: string;
  sellingPriceCents: number | null;
  /** Null when the product is missing data (see `missing`). */
  profit: ProductProfit | null;
};

export type ProfitLever =
  | {
      kind: 'reprice';
      productId: string;
      name: string;
      fromCents: number;
      toCents: number;
      /** €/hour gained on this product's production hours by pricing at the floor. */
      hourGainCents: number;
    }
  | {
      kind: 'raisePrice';
      productId: string;
      name: string;
      /** Price rise tested, in bps (1000 = 10%). */
      riseBps: number;
      hourGainCents: number;
    };

export type CatalogueSummary = {
  heroes: CatalogueProductRow[];
  belowFloor: CatalogueProductRow[];
  lever: ProfitLever | null;
};

/** Ranked by €/hour descending; incomplete products sink to the bottom, by name. */
export function rankCatalogue<T extends CatalogueProductRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.profit && b.profit) {
      return b.profit.euroPerHourCents - a.profit.euroPerHourCents || a.name.localeCompare(b.name);
    }
    if (a.profit) return -1;
    if (b.profit) return 1;
    return a.name.localeCompare(b.name);
  });
}

const LEVER_RISE_BPS = 1_000;

export function summarizeCatalogue(
  rows: CatalogueProductRow[],
  rate: HourlyRate | null,
): CatalogueSummary {
  const ranked = rankCatalogue(rows).filter((r) => r.profit !== null);
  if (!rate) return { heroes: [], belowFloor: [], lever: null };

  const heroes = ranked.filter((r) => r.profit?.verdict === 'hero').slice(0, 3);
  const belowFloor = ranked.filter((r) => r.profit?.flags.includes('belowFloor'));

  let lever: ProfitLever | null = null;
  if (belowFloor.length > 0) {
    // The product whose production hours are furthest under the rate: repricing it
    // to its floor recovers the most per hour spent making it.
    let best: CatalogueProductRow | null = null;
    for (const row of belowFloor) {
      if (!best || (row.profit as ProductProfit).euroPerHourCents < (best.profit as ProductProfit).euroPerHourCents) {
        best = row;
      }
    }
    if (best?.profit && best.profit.floorPriceCents !== null && best.sellingPriceCents !== null) {
      lever = {
        kind: 'reprice',
        productId: best.id,
        name: best.name,
        fromCents: best.sellingPriceCents,
        toCents: best.profit.floorPriceCents,
        hourGainCents: rate.trueHourlyRateCents - best.profit.euroPerHourCents,
      };
    }
  } else if (ranked.length > 0) {
    // Nothing below the floor: test a 10% rise on the weakest earner.
    const weakest = ranked[ranked.length - 1];
    if (weakest?.profit && weakest.sellingPriceCents !== null && weakest.sellingPriceCents > 0) {
      lever = {
        kind: 'raisePrice',
        productId: weakest.id,
        name: weakest.name,
        riseBps: LEVER_RISE_BPS,
        hourGainCents: Math.round(
          ((weakest.sellingPriceCents * LEVER_RISE_BPS) / BPS) * weakest.profit.unitsPerHour,
        ),
      };
    }
  }

  return { heroes, belowFloor, lever };
}
