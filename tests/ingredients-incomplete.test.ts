import { describe, expect, it } from 'vitest';
import { displayPriceCents, isIncomplete, type IncompleteCandidate } from '@/lib/ingredients/incomplete';

/**
 * Decision D2 (`docs/supplier-dialog-ux-plan.md`): "incomplete" means the COST is
 * untrustworthy, nothing else. The regression this file exists to prevent is a
 * predicate that reads `priceCents` unconditionally and so marks every KITCHEN row
 * incomplete — kitchen payloads carry no price key at all (Sprint F4).
 */

const row = (over: Partial<IncompleteCandidate> = {}): IncompleteCandidate => ({
  needsPricing: false,
  priceCents: 1200,
  ...over,
});

describe('isIncomplete', () => {
  it('flags a row whose needsPricing flag is set', () => {
    expect(isIncomplete(row({ needsPricing: true }), true)).toBe(true);
  });

  it('flags a priced-at-zero row even though needsPricing is false', () => {
    // The hole the flag alone leaves: an ingredient created without a price.
    expect(isIncomplete(row({ priceCents: 0 }), true)).toBe(true);
  });

  it('leaves a properly priced row alone', () => {
    expect(isIncomplete(row(), true)).toBe(false);
  });

  it('treats a null price as zero', () => {
    expect(isIncomplete(row({ priceCents: null }), true)).toBe(true);
  });

  it('does NOT flag a kitchen row that carries no price key', () => {
    // The whole reason `canSeeCosts` is a parameter. Without it every row in the
    // kitchen list would be pinned, which is the same as pinning none of them.
    const kitchenRow: IncompleteCandidate = { needsPricing: false };
    expect(isIncomplete(kitchenRow, false)).toBe(false);
  });

  it('still flags a kitchen row that the server marked as needing pricing', () => {
    expect(isIncomplete({ needsPricing: true }, false)).toBe(true);
  });

  it('ignores the price for a kitchen viewer even when one leaked through', () => {
    expect(isIncomplete(row({ priceCents: 0 }), false)).toBe(false);
  });
});

/**
 * The grid's two-tier comparator, reproduced here over the same predicate. The
 * grid is a client component full of TanStack/next-intl imports, so the ORDERING
 * is proven against the extracted rule rather than by rendering.
 */
describe('two-tier ordering', () => {
  type Row = IncompleteCandidate & { name: string };
  const byName = (a: Row, b: Row) => a.name.localeCompare(b.name);
  const sorted = (rows: Row[], canSeeCosts: boolean) =>
    [...rows]
      .sort(
        (a, b) =>
          Number(isIncomplete(b, canSeeCosts)) - Number(isIncomplete(a, canSeeCosts)) ||
          byName(a, b),
      )
      .map((r) => r.name);

  const rows: Row[] = [
    { name: 'Almonds', needsPricing: false, priceCents: 900 },
    { name: 'Butter', needsPricing: true, priceCents: 0 },
    { name: 'Cocoa', needsPricing: false, priceCents: 0 },
    { name: 'Dates', needsPricing: false, priceCents: 450 },
  ];

  it('pins untrustworthy rows above the chosen ordering', () => {
    expect(sorted(rows, true)).toEqual(['Butter', 'Cocoa', 'Almonds', 'Dates']);
  });

  it('still applies the chosen ordering inside each tier', () => {
    const reversed = [...rows].reverse();
    expect(sorted(reversed, true)).toEqual(sorted(rows, true));
  });

  it('drops a row into its normal position once it gets a price', () => {
    const fixed = rows.map((r) =>
      r.name === 'Cocoa' ? { ...r, priceCents: 700 } : r,
    );
    expect(sorted(fixed, true)).toEqual(['Butter', 'Almonds', 'Cocoa', 'Dates']);
  });

  it('leaves a kitchen list in plain name order', () => {
    // No price key anywhere, no needsPricing → nothing is pinned.
    const kitchen: Row[] = rows.map(({ name }) => ({ name, needsPricing: false }));
    expect(sorted(kitchen, false)).toEqual(['Almonds', 'Butter', 'Cocoa', 'Dates']);
  });
});

describe('displayPriceCents', () => {
  it('hides the placeholder zero of an ingredient that needs pricing', () => {
    expect(displayPriceCents(row({ needsPricing: true, priceCents: 0 }))).toBeNull();
  });

  it('hides any stored price while the row still needs pricing', () => {
    expect(displayPriceCents(row({ needsPricing: true, priceCents: 450 }))).toBeNull();
  });

  it('keeps a deliberately recorded zero price', () => {
    expect(displayPriceCents(row({ priceCents: 0 }))).toBe(0);
  });

  it('shows a normal price', () => {
    expect(displayPriceCents(row())).toBe(1200);
  });

  it('returns null for a kitchen payload with no price key', () => {
    expect(displayPriceCents({ needsPricing: false })).toBeNull();
  });

  it('returns null for a non-finite price', () => {
    expect(displayPriceCents(row({ priceCents: Number.NaN }))).toBeNull();
    expect(displayPriceCents(row({ priceCents: Number.POSITIVE_INFINITY }))).toBeNull();
  });
});
