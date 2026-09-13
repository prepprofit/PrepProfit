import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WASTE_BPS,
  monthlyDepreciationCents,
  productProfit,
  rankCatalogue,
  summarizeCatalogue,
  trueHourlyRate,
  verdictFor,
  type CatalogueProductRow,
  type FixedCostsCents,
  type HourlyRate,
  type ProductProfitInput,
} from './profit-hour';

const ZERO_COSTS: FixedCostsCents = {
  rent: 0,
  equipmentLeases: 0,
  equipmentDepreciation: 0,
  insuranceLicenses: 0,
  utilities: 0,
  salariedStaff: 0,
  software: 0,
};

/** €2,000/month over 100 h = €20/h fixed + €15/h owner = €35/h. */
const RATE: HourlyRate = {
  totalMonthlyFixedCostsCents: 200_000,
  fixedCostPerHourCents: 2_000,
  ownerTargetIncomePerHourCents: 1_500,
  trueHourlyRateCents: 3_500,
  ingredientMultiplierBps: 10_000,
};

const BASE: ProductProfitInput = {
  ingredientCostPerBatchCents: 1_200, // €12 for the batch
  packagingPerBatchCents: 0,
  energyPerBatchCents: 0,
  deliveryPerUnitCents: 0,
  wasteBps: 0,
  batchMinutes: 60,
  batchYield: 12, // 12 units/hour, €1 ingredient per unit
  sellingPriceCents: 500,
};

describe('trueHourlyRate', () => {
  it('sums fixed costs, divides by hours and adds the owner target', () => {
    const rate = trueHourlyRate({
      fixedCostsCents: { ...ZERO_COSTS, rent: 120_000, software: 5_000, salariedStaff: 75_000 },
      productiveHoursPerMonth: 100,
      ownerTargetIncomePerHourCents: 1_500,
      subletEnabled: false,
      subletIngredientMultiplierBps: 14_000,
    });
    expect(rate).toEqual({
      totalMonthlyFixedCostsCents: 200_000,
      fixedCostPerHourCents: 2_000,
      ownerTargetIncomePerHourCents: 1_500,
      trueHourlyRateCents: 3_500,
      ingredientMultiplierBps: 10_000,
    });
  });

  it('sublet drops rent and applies the ingredient multiplier', () => {
    const rate = trueHourlyRate({
      fixedCostsCents: { ...ZERO_COSTS, rent: 120_000, software: 5_000 },
      productiveHoursPerMonth: 100,
      ownerTargetIncomePerHourCents: 0,
      subletEnabled: true,
      subletIngredientMultiplierBps: 14_000,
    });
    expect(rate?.totalMonthlyFixedCostsCents).toBe(5_000);
    expect(rate?.fixedCostPerHourCents).toBe(50);
    expect(rate?.ingredientMultiplierBps).toBe(14_000);
  });

  it('returns null for zero, negative, NaN and Infinity hours', () => {
    for (const hours of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        trueHourlyRate({
          fixedCostsCents: ZERO_COSTS,
          productiveHoursPerMonth: hours,
          ownerTargetIncomePerHourCents: 1_000,
          subletEnabled: false,
          subletIngredientMultiplierBps: 14_000,
        }),
      ).toBeNull();
    }
  });

  it('ignores negative and non-finite cost lines instead of letting them lower the rate', () => {
    const rate = trueHourlyRate({
      fixedCostsCents: { ...ZERO_COSTS, rent: -50_000, utilities: Number.NaN, software: 10_000 },
      productiveHoursPerMonth: 3,
      ownerTargetIncomePerHourCents: Number.POSITIVE_INFINITY,
      subletEnabled: false,
      subletIngredientMultiplierBps: 14_000,
    });
    expect(rate?.totalMonthlyFixedCostsCents).toBe(10_000);
    // 10000 / 3 = 3333.33 → rounds once at the boundary.
    expect(rate?.fixedCostPerHourCents).toBe(3_333);
    expect(rate?.trueHourlyRateCents).toBe(3_333);
  });

  it('handles large values without overflow', () => {
    const rate = trueHourlyRate({
      fixedCostsCents: { ...ZERO_COSTS, salariedStaff: 90_000_000 },
      productiveHoursPerMonth: 700,
      ownerTargetIncomePerHourCents: 100_000,
      subletEnabled: false,
      subletIngredientMultiplierBps: 14_000,
    });
    expect(rate?.trueHourlyRateCents).toBe(Math.round(90_000_000 / 700) + 100_000);
  });
});

describe('monthlyDepreciationCents', () => {
  it('spreads the purchase over years × 12', () => {
    expect(monthlyDepreciationCents(600_000, 5)).toBe(10_000);
    expect(monthlyDepreciationCents(100_000, 3)).toBe(2_778);
  });

  it('returns null for invalid years or price', () => {
    expect(monthlyDepreciationCents(100_000, 0)).toBeNull();
    expect(monthlyDepreciationCents(100_000, Number.NaN)).toBeNull();
    expect(monthlyDepreciationCents(-1, 5)).toBeNull();
  });
});

describe('productProfit', () => {
  it('computes the brief formulas', () => {
    const p = productProfit(
      {
        ...BASE,
        packagingPerBatchCents: 240, // 20c/unit
        energyPerBatchCents: 120, // 10c/unit
        deliveryPerUnitCents: 30,
        wasteBps: 1_000, // 10%
      },
      RATE,
    );
    // variable = 100 × 1.1 + 20 + 10 + 30 = 170
    expect(p?.variableCostPerUnitCents).toBe(170);
    expect(p?.minutesPerUnit).toBe(5);
    expect(p?.unitsPerHour).toBe(12);
    // €/h = (500 − 170) × 12 = 3960
    expect(p?.euroPerHourCents).toBe(3_960);
    // floor = 170 + (5/60) × 3500 = 461.67 → 462
    expect(p?.floorPriceCents).toBe(462);
    expect(p?.discountRoomCents).toBe(38);
    // margin = (500 − 100) / 500 = 80%
    expect(p?.marginBps).toBe(8_000);
    expect(p?.verdict).toBe('solid');
    expect(p?.flags).toEqual([]);
  });

  it('flags a product selling below its hourly floor', () => {
    const p = productProfit({ ...BASE, sellingPriceCents: 350 }, RATE);
    // €/h = 250 × 12 = 3000 < 3500; floor = 100 + 291.67 = 392
    expect(p?.floorPriceCents).toBe(392);
    expect(p?.flags).toContain('belowFloor');
    expect(p?.discountRoomCents).toBe(-42);
    expect(p?.verdict).toBe('fragile');
  });

  it('flags high margin with a low hourly yield', () => {
    // €1 ingredient, €4 price → 75% margin, but only 2 units/hour → €6/h.
    const p = productProfit({ ...BASE, batchYield: 2, ingredientCostPerBatchCents: 200, sellingPriceCents: 400 }, RATE);
    expect(p?.marginBps).toBe(7_500);
    expect(p?.flags).toContain('highMarginLowHour');
    expect(p?.verdict).toBe('losing');
  });

  it('flags a low-margin product that is actually strong per hour', () => {
    // €2 ingredient, €4 price → 50% margin, 60 units/hour → €120/h.
    const p = productProfit(
      { ...BASE, batchYield: 60, ingredientCostPerBatchCents: 12_000, sellingPriceCents: 400 },
      RATE,
    );
    expect(p?.marginBps).toBe(5_000);
    expect(p?.flags).toContain('lowMarginStrong');
    expect(p?.verdict).toBe('hero');
  });

  it('applies the sublet ingredient multiplier to variable cost but not to margin', () => {
    const p = productProfit(BASE, { ...RATE, ingredientMultiplierBps: 14_000 });
    expect(p?.variableCostPerUnitCents).toBe(140);
    expect(p?.marginBps).toBe(8_000);
  });

  it('computes the implied extra-step rate and flags it below the true rate', () => {
    const p = productProfit({ ...BASE, extraStep: { minutes: 10, priceCents: 300 } }, RATE);
    expect(p?.extraStepRateCents).toBe(1_800);
    expect(p?.extraStepBelowRate).toBe(true);
    const good = productProfit({ ...BASE, extraStep: { minutes: 2, priceCents: 300 } }, RATE);
    expect(good?.extraStepRateCents).toBe(9_000);
    expect(good?.extraStepBelowRate).toBe(false);
  });

  it('works without a rate: no floor, verdict or flags', () => {
    const p = productProfit(BASE, null);
    expect(p?.euroPerHourCents).toBe(4_800);
    expect(p?.floorPriceCents).toBeNull();
    expect(p?.discountRoomCents).toBeNull();
    expect(p?.verdict).toBeNull();
    expect(p?.flags).toEqual([]);
  });

  it('returns null margin for a zero price and a negative €/hour', () => {
    const p = productProfit({ ...BASE, sellingPriceCents: 0 }, RATE);
    expect(p?.marginBps).toBeNull();
    expect(p?.euroPerHourCents).toBe(-1_200);
    expect(p?.verdict).toBe('losing');
  });

  it('returns null for unusable time, yield, price or cost', () => {
    const bad: Partial<ProductProfitInput>[] = [
      { batchMinutes: 0 },
      { batchMinutes: -5 },
      { batchMinutes: Number.NaN },
      { batchYield: 0 },
      { batchYield: Number.POSITIVE_INFINITY },
      { sellingPriceCents: -1 },
      { sellingPriceCents: Number.NaN },
      { ingredientCostPerBatchCents: Number.NaN },
    ];
    for (const patch of bad) {
      expect(productProfit({ ...BASE, ...patch }, RATE)).toBeNull();
    }
  });

  it('falls back to default waste for a non-finite waste and clamps to 0..100%', () => {
    const nan = productProfit({ ...BASE, wasteBps: Number.NaN }, RATE);
    expect(nan?.variableCostPerUnitCents).toBe(100 + (100 * DEFAULT_WASTE_BPS) / 10_000);
    const negative = productProfit({ ...BASE, wasteBps: -500 }, RATE);
    expect(negative?.variableCostPerUnitCents).toBe(100);
    const huge = productProfit({ ...BASE, wasteBps: 50_000 }, RATE);
    expect(huge?.variableCostPerUnitCents).toBe(200);
  });

  it('rounds fractional per-unit costs once', () => {
    const p = productProfit({ ...BASE, ingredientCostPerBatchCents: 1_000, batchYield: 3 }, null);
    expect(p?.ingredientCostPerUnitCents).toBe(333);
    // (500 − 333.33) × 3 = 500.00
    expect(p?.euroPerHourCents).toBe(500);
  });
});

describe('verdictFor', () => {
  it('bands €/hour against the rate and the fixed-cost part of it', () => {
    expect(verdictFor(4_375, RATE)).toBe('hero');
    expect(verdictFor(4_374, RATE)).toBe('solid');
    expect(verdictFor(3_500, RATE)).toBe('solid');
    expect(verdictFor(3_499, RATE)).toBe('fragile');
    expect(verdictFor(2_000, RATE)).toBe('fragile');
    expect(verdictFor(1_999, RATE)).toBe('losing');
    expect(verdictFor(-100, RATE)).toBe('losing');
  });

  it('never calls a loss-maker a hero when the rate is zero', () => {
    const zero: HourlyRate = { ...RATE, fixedCostPerHourCents: 0, trueHourlyRateCents: 0 };
    expect(verdictFor(0, zero)).toBe('losing');
    expect(verdictFor(-5, zero)).toBe('losing');
    expect(verdictFor(1, zero)).toBe('hero');
  });
});

describe('catalogue ranking + summary', () => {
  const row = (id: string, input: Partial<ProductProfitInput> | null): CatalogueProductRow => {
    const merged = { ...BASE, ...input };
    return {
      id,
      name: id,
      sellingPriceCents: input ? merged.sellingPriceCents : null,
      profit: input ? productProfit(merged, RATE) : null,
    };
  };

  const rows = [
    row('slow', { batchYield: 2, sellingPriceCents: 400, ingredientCostPerBatchCents: 200 }), // €6/h, losing
    row('ok', { sellingPriceCents: 350 }), // €30/h, fragile
    row('hero1', { batchYield: 60, ingredientCostPerBatchCents: 12_000, sellingPriceCents: 400 }), // €120/h
    row('incomplete', null),
    row('hero2', { sellingPriceCents: 800 }), // €84/h
    row('hero3', { sellingPriceCents: 600 }), // €60/h
    row('hero4', { sellingPriceCents: 550 }), // €54/h
  ];

  it('ranks by €/hour descending with incomplete products last', () => {
    expect(rankCatalogue(rows).map((r) => r.id)).toEqual([
      'hero1',
      'hero2',
      'hero3',
      'hero4',
      'ok',
      'slow',
      'incomplete',
    ]);
  });

  it('summarises the top 3 heroes, below-floor products and the reprice lever', () => {
    const summary = summarizeCatalogue(rows, RATE);
    expect(summary.heroes.map((r) => r.id)).toEqual(['hero1', 'hero2', 'hero3']);
    expect(summary.belowFloor.map((r) => r.id)).toEqual(['ok', 'slow']);
    expect(summary.lever).toMatchObject({
      kind: 'reprice',
      productId: 'slow',
      fromCents: 400,
      hourGainCents: 3_500 - 600,
    });
  });

  it('suggests a 10% rise on the weakest earner when nothing is below the floor', () => {
    const summary = summarizeCatalogue([rows[2]!, rows[4]!], RATE);
    expect(summary.belowFloor).toEqual([]);
    // hero2: +80c × 12 units/hour = 960
    expect(summary.lever).toEqual({
      kind: 'raisePrice',
      productId: 'hero2',
      name: 'hero2',
      riseBps: 1_000,
      hourGainCents: 960,
    });
  });

  it('returns an empty summary without a rate or products', () => {
    expect(summarizeCatalogue(rows, null)).toEqual({ heroes: [], belowFloor: [], lever: null });
    expect(summarizeCatalogue([], RATE)).toEqual({ heroes: [], belowFloor: [], lever: null });
  });
});
