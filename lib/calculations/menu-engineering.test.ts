import { describe, expect, it } from 'vitest';
import {
  classifyMenuItems,
  type MenuEngineeringInputItem,
} from './menu-engineering';

/**
 * A sold item shortcut. Defaults keep every item classifiable so a test only states
 * the axis it cares about.
 */
function item(
  over: Partial<MenuEngineeringInputItem> & { id: string },
): MenuEngineeringInputItem {
  return {
    kind: 'recipe',
    name: over.id,
    unitsSold: 10,
    sellingPriceCents: 1000,
    costCents: 300,
    ...over,
  };
}

describe('classifyMenuItems', () => {
  it('returns an empty result for no sales', () => {
    const result = classifyMenuItems([]);
    expect(result.classified).toEqual([]);
    expect(result.needsPricing).toEqual([]);
    expect(result.totalUnitsSold).toBe(0);
    expect(result.averageUnitsSold).toBe(0);
    expect(result.averageContributionMarginCents).toBe(0);
    expect(result.counts).toEqual({ star: 0, puzzle: 0, workhorse: 0, dog: 0 });
  });

  it('classifies the four quadrants relative to the org averages', () => {
    // avg units = (100+100+10+10)/4 = 55; avg CM = (700+100+700+100)/4 = 400.
    const result = classifyMenuItems([
      // high pop, high profit → star
      item({ id: 'star', unitsSold: 100, sellingPriceCents: 1000, costCents: 300 }),
      // high pop, low profit → workhorse
      item({ id: 'work', unitsSold: 100, sellingPriceCents: 1000, costCents: 900 }),
      // low pop, high profit → puzzle
      item({ id: 'puzz', unitsSold: 10, sellingPriceCents: 1000, costCents: 300 }),
      // low pop, low profit → dog
      item({ id: 'dog', unitsSold: 10, sellingPriceCents: 1000, costCents: 900 }),
    ]);

    const byId = new Map(result.classified.map((c) => [c.id, c]));
    expect(byId.get('star')!.class).toBe('star');
    expect(byId.get('work')!.class).toBe('workhorse');
    expect(byId.get('puzz')!.class).toBe('puzzle');
    expect(byId.get('dog')!.class).toBe('dog');
    expect(result.counts).toEqual({ star: 1, puzzle: 1, workhorse: 1, dog: 1 });
    expect(result.averageUnitsSold).toBe(55);
    expect(result.averageContributionMarginCents).toBe(400);
    expect(result.totalUnitsSold).toBe(220);
  });

  it('sorts classified star→puzzle→workhorse→dog, then by units desc', () => {
    const result = classifyMenuItems([
      item({ id: 'dog', unitsSold: 10, costCents: 900 }),
      item({ id: 'star', unitsSold: 100, costCents: 300 }),
      item({ id: 'work', unitsSold: 100, costCents: 900 }),
      item({ id: 'puzz', unitsSold: 10, costCents: 300 }),
    ]);
    expect(result.classified.map((c) => c.class)).toEqual([
      'star',
      'puzzle',
      'workhorse',
      'dog',
    ]);
  });

  it('flags high-volume low-margin items as workhorses', () => {
    const result = classifyMenuItems([
      item({ id: 'burger', unitsSold: 500, sellingPriceCents: 1200, costCents: 1100 }),
      item({ id: 'salad', unitsSold: 20, sellingPriceCents: 1200, costCents: 300 }),
    ]);
    const burger = result.classified.find((c) => c.id === 'burger')!;
    expect(burger.class).toBe('workhorse');
    expect(burger.highPopularity).toBe(true);
    expect(burger.highProfitability).toBe(false);
  });

  it('sets aside items without a selling price as needs-pricing (MISSING_SELLING_PRICE)', () => {
    const result = classifyMenuItems([
      item({ id: 'priced', unitsSold: 10 }),
      item({ id: 'noprice', unitsSold: 40, sellingPriceCents: null }),
      item({ id: 'zeroprice', unitsSold: 5, sellingPriceCents: 0 }),
    ]);
    expect(result.classified.map((c) => c.id)).toEqual(['priced']);
    expect(result.needsPricing).toEqual([
      { kind: 'recipe', id: 'noprice', name: 'noprice', unitsSold: 40, reason: 'MISSING_SELLING_PRICE' },
      { kind: 'recipe', id: 'zeroprice', name: 'zeroprice', unitsSold: 5, reason: 'MISSING_SELLING_PRICE' },
    ]);
  });

  it('sets aside items with an unavailable cost as needs-pricing (MISSING_COST)', () => {
    const result = classifyMenuItems([
      item({ id: 'ok', unitsSold: 10 }),
      item({ id: 'nocost', unitsSold: 30, costCents: null }),
    ]);
    expect(result.classified.map((c) => c.id)).toEqual(['ok']);
    expect(result.needsPricing).toEqual([
      { kind: 'recipe', id: 'nocost', name: 'nocost', unitsSold: 30, reason: 'MISSING_COST' },
    ]);
  });

  it('prioritizes MISSING_SELLING_PRICE over MISSING_COST when both are absent', () => {
    const result = classifyMenuItems([
      item({ id: 'both', sellingPriceCents: null, costCents: null }),
    ]);
    expect(result.needsPricing[0]!.reason).toBe('MISSING_SELLING_PRICE');
  });

  it('excludes needs-pricing items from the averages so they never skew a quadrant', () => {
    // Without the unpriced item the two costed items average to units 10, CM 700.
    const result = classifyMenuItems([
      item({ id: 'a', unitsSold: 10, costCents: 300 }),
      item({ id: 'b', unitsSold: 10, costCents: 300 }),
      item({ id: 'ghost', unitsSold: 9999, sellingPriceCents: null }),
    ]);
    expect(result.totalUnitsSold).toBe(20);
    expect(result.averageUnitsSold).toBe(10);
    expect(result.averageContributionMarginCents).toBe(700);
  });

  it('treats a lone classifiable item as a star (inclusive thresholds)', () => {
    const result = classifyMenuItems([item({ id: 'solo', unitsSold: 3 })]);
    expect(result.classified).toHaveLength(1);
    expect(result.classified[0]!.class).toBe('star');
    expect(result.classified[0]!.popularityShare).toBe(1);
  });

  it('keeps a negative contribution margin as a real (low-profit) value, never fake', () => {
    const result = classifyMenuItems([
      item({ id: 'loss', unitsSold: 5, sellingPriceCents: 500, costCents: 800 }),
      item({ id: 'good', unitsSold: 15, sellingPriceCents: 1000, costCents: 300 }),
    ]);
    const loss = result.classified.find((c) => c.id === 'loss')!;
    expect(loss.contributionMarginCents).toBe(-300);
    expect(loss.marginPercent).toBe(-60);
    expect(loss.highProfitability).toBe(false);
    expect(loss.highPopularity).toBe(false);
    expect(loss.class).toBe('dog');
  });

  it('guards against a non-finite cost by routing it to needs-pricing', () => {
    const result = classifyMenuItems([
      item({ id: 'nan', costCents: Number.NaN }),
    ]);
    expect(result.classified).toEqual([]);
    expect(result.needsPricing[0]!.reason).toBe('MISSING_COST');
  });

  it('carries the item kind through classification and needs-pricing', () => {
    const result = classifyMenuItems([
      item({ kind: 'menu', id: 'm1', unitsSold: 10 }),
      item({ kind: 'menu', id: 'm2', unitsSold: 10, sellingPriceCents: null }),
    ]);
    expect(result.classified[0]!.kind).toBe('menu');
    expect(result.needsPricing[0]!.kind).toBe('menu');
  });
});
