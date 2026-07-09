import { describe, expect, it } from 'vitest';

import { suggestedYieldWeight } from './suggestedYieldWeight';

const weight = (quantityCanonical: number) =>
  ({ dimension: 'weight', quantityCanonical }) as const;

describe('suggestedYieldWeight', () => {
  it('sums direct weight lines and rounds to 2 decimals', () => {
    const result = suggestedYieldWeight({
      lines: [weight(1000), weight(200), weight(0.005)],
      components: [],
    });
    expect(result).toEqual({
      grams: 1200.01,
      skippedLines: 0,
      includedWeightLines: 3,
      includedComponents: 0,
    });
  });

  it('skips volume and count lines but keeps the weight sum', () => {
    const result = suggestedYieldWeight({
      lines: [
        weight(1000),
        { dimension: 'volume', quantityCanonical: 100 },
        { dimension: 'count', quantityCanonical: 2 },
      ],
      components: [],
    });
    expect(result.grams).toBe(1000);
    expect(result.skippedLines).toBe(2);
    expect(result.includedWeightLines).toBe(1);
  });

  it('sums components only', () => {
    const result = suggestedYieldWeight({
      lines: [],
      components: [{ quantityGrams: 300 }, { quantityGrams: 500 }],
    });
    expect(result.grams).toBe(800);
    expect(result.includedComponents).toBe(2);
  });

  it('sums direct weight plus components', () => {
    const result = suggestedYieldWeight({
      lines: [weight(500)],
      components: [{ quantityGrams: 300 }],
    });
    expect(result.grams).toBe(800);
    expect(result.includedWeightLines).toBe(1);
    expect(result.includedComponents).toBe(1);
  });

  it('returns null grams for an empty recipe', () => {
    expect(suggestedYieldWeight({ lines: [], components: [] })).toEqual({
      grams: null,
      skippedLines: 0,
      includedWeightLines: 0,
      includedComponents: 0,
    });
  });

  it('returns null grams and skipped count for all non-weight lines', () => {
    const result = suggestedYieldWeight({
      lines: [
        { dimension: 'volume', quantityCanonical: 100 },
        { dimension: 'count', quantityCanonical: 3 },
      ],
      components: [],
    });
    expect(result.grams).toBeNull();
    expect(result.skippedLines).toBe(2);
  });

  it('ignores zero weight lines without counting them skipped', () => {
    const result = suggestedYieldWeight({
      lines: [weight(0), weight(100)],
      components: [],
    });
    expect(result.grams).toBe(100);
    expect(result.skippedLines).toBe(0);
    expect(result.includedWeightLines).toBe(1);
  });

  it('skips negative and non-finite weight lines', () => {
    const result = suggestedYieldWeight({
      lines: [weight(-5), weight(NaN), weight(Infinity), weight(100)],
      components: [],
    });
    expect(result.grams).toBe(100);
    expect(result.skippedLines).toBe(3);
  });

  it('ignores invalid component quantities silently', () => {
    const result = suggestedYieldWeight({
      lines: [],
      components: [
        { quantityGrams: 0 },
        { quantityGrams: -10 },
        { quantityGrams: NaN },
        { quantityGrams: 250 },
      ],
    });
    expect(result.grams).toBe(250);
    expect(result.skippedLines).toBe(0);
    expect(result.includedComponents).toBe(1);
  });

  it('regression: takes no yieldPercentage and applies no loss factor', () => {
    // 1000 g at 80% usable yield must still suggest 1000 g — the helper's
    // input type has no yieldPercentage field, and the sum is raw.
    const result = suggestedYieldWeight({
      lines: [weight(1000)],
      components: [],
    });
    expect(result.grams).toBe(1000);
  });
});
