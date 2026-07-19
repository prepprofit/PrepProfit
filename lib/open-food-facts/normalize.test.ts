import { describe, expect, it } from 'vitest';

import { offResponseSchema, type OffProduct } from './schemas';
import { normalizeOffProduct } from './normalize';

import solidFixture from './__fixtures__/solid-food-100g.json';
import beverageFixture from './__fixtures__/beverage-100ml.json';
import multilingualFixture from './__fixtures__/multilingual.json';
import partialFixture from './__fixtures__/partial-nutrition.json';
import severeFixture from './__fixtures__/severe-quality.json';
import nonFoodFixture from './__fixtures__/non-food.json';
import leadingZeroFixture from './__fixtures__/leading-zero-upc.json';
import unknownFieldsFixture from './__fixtures__/unknown-fields.json';

/** Parse a fixture through the real schema and return its product (as OFF does). */
function productOf(fixture: unknown): OffProduct {
  const parsed = offResponseSchema.parse(fixture);
  if (!parsed.product) throw new Error('fixture has no product');
  return parsed.product;
}

describe('normalizeOffProduct — 100 g solid food', () => {
  const r = normalizeOffProduct(productOf(solidFixture), '3017620422003');

  it('maps core nutrients on a per-100 g basis and classifies complete', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.snapshot;
    expect(s.basis).toEqual({ quantity: 100, unit: 'g' });
    expect(s.nutrients.caloriesKcal).toBe(539);
    expect(s.nutrients.totalFatG).toBe(30.9);
    expect(s.nutrients.totalCarbohydrateG).toBe(57.5);
    expect(s.nutrients.proteinG).toBe(6.3);
    expect(s.saltG).toBe(0.107);
    expect(s.nutrients.sodiumMg).toBeCloseTo(42.8, 4); // 0.0428 g × 1000
    expect(s.qualityStatus).toBe('complete');
    expect(s.derivedFields).toEqual([]);
  });

  it('keeps commonly-absent EU nutrients null (never 0)', () => {
    if (!r.ok) return;
    expect(r.snapshot.nutrients.transFatG).toBeNull();
    expect(r.snapshot.nutrients.cholesterolMg).toBeNull();
    expect(r.snapshot.nutrients.addedSugarsG).toBeNull();
    expect(r.snapshot.nutrients.calciumMg).toBeNull();
  });
});

describe('normalizeOffProduct — 100 ml beverage', () => {
  it('detects the ml basis and NEVER relabels it as g', () => {
    const r = normalizeOffProduct(productOf(beverageFixture), '5449000000996');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.basis.unit).toBe('ml');
    expect(r.snapshot.qualityWarnings).toContain('BASIS_VOLUME');
  });

  it('derives sodium from salt when sodium is absent', () => {
    const r = normalizeOffProduct(productOf(beverageFixture), '5449000000996');
    if (!r.ok) return;
    expect(r.snapshot.derivedFields).toContain('sodiumMg');
    expect(r.snapshot.qualityWarnings).toContain('SODIUM_DERIVED_FROM_SALT');
    expect(r.snapshot.nutrients.sodiumMg).toBe(0); // salt 0 → sodium 0
  });
});

describe('normalizeOffProduct — derivations & languages', () => {
  it('derives kcal from kJ and picks the localized name', () => {
    const r = normalizeOffProduct(productOf(multilingualFixture), '8410376033216');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.description).toBe('Aceite de oliva virgen extra');
    expect(r.snapshot.sourceLanguage).toBe('es');
    expect(r.snapshot.derivedFields).toContain('caloriesKcal');
    expect(r.snapshot.qualityWarnings).toContain('ENERGY_DERIVED_FROM_KJ');
    // 3700 kJ / 4.184 ≈ 884.3 kcal (< 900 ceiling)
    expect(r.snapshot.nutrients.caloriesKcal).toBeCloseTo(884.32, 1);
  });
});

describe('normalizeOffProduct — partial nutrition', () => {
  it('flags missing core nutrients and classifies partial', () => {
    const r = normalizeOffProduct(productOf(partialFixture), '5000112637922');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.qualityStatus).toBe('partial');
    expect(r.snapshot.qualityWarnings).toContain('MISSING_CORE_NUTRIENT');
    expect(r.snapshot.nutrients.totalCarbohydrateG).toBeNull();
    expect(r.snapshot.nutrients.sodiumMg).toBeNull();
    expect(r.snapshot.saltG).toBeNull();
  });
});

describe('normalizeOffProduct — rejections', () => {
  it('rejects a corrupt (negative) value as INVALID', () => {
    const r = normalizeOffProduct(productOf(severeFixture), '4006381333931');
    expect(r).toEqual({ ok: false, reason: 'INVALID' });
  });

  it('rejects a non-food product', () => {
    const r = normalizeOffProduct(productOf(nonFoodFixture), '3600542525732');
    expect(r).toEqual({ ok: false, reason: 'NON_FOOD' });
  });
});

describe('normalizeOffProduct — code handling', () => {
  it('preserves a leading-zero UPC/EAN code', () => {
    const r = normalizeOffProduct(productOf(leadingZeroFixture), '0048151623426');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.externalId).toBe('0048151623426');
    expect(r.snapshot.barcode).toBe('0048151623426');
    expect(r.snapshot.qualityStatus).toBe('complete');
  });

  it('ignores unknown top-level and nutriment fields', () => {
    const r = normalizeOffProduct(productOf(unknownFieldsFixture), '7622210449283');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.qualityStatus).toBe('complete');
    expect(r.snapshot.nutrients.caloriesKcal).toBe(480);
    // salt 0.9 and sodium 0.36 agree (0.9 / 2.5 = 0.36) → no mismatch warning.
    expect(r.snapshot.qualityWarnings).not.toContain('SALT_SODIUM_MISMATCH');
  });
});
