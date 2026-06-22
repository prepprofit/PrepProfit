import { describe, it, expect } from 'vitest';
import { menuSchema } from '@/lib/validation/menus';

/** Server-side menu validation (Sprint 10) — the guard before any data access. */
describe('menuSchema', () => {
  const base = {
    name: 'Combo',
    items: [{ recipeId: 'r1', quantity: 2 }],
  };

  it('accepts a valid menu with a null/absent price', () => {
    expect(menuSchema.safeParse(base).success).toBe(true);
    expect(
      menuSchema.safeParse({ ...base, sellingPriceCents: null }).success,
    ).toBe(true);
  });

  it('rejects an empty item set (no draft/empty menu)', () => {
    expect(menuSchema.safeParse({ ...base, items: [] }).success).toBe(false);
  });

  it('rejects duplicate recipe ids before data access', () => {
    const dup = menuSchema.safeParse({
      ...base,
      items: [
        { recipeId: 'r1', quantity: 1 },
        { recipeId: 'r1', quantity: 2 },
      ],
    });
    expect(dup.success).toBe(false);
  });

  it('rejects an out-of-range quantity', () => {
    expect(
      menuSchema.safeParse({ ...base, items: [{ recipeId: 'r1', quantity: 0 }] })
        .success,
    ).toBe(false);
    expect(
      menuSchema.safeParse({ ...base, items: [{ recipeId: 'r1', quantity: 1001 }] })
        .success,
    ).toBe(false);
    expect(
      menuSchema.safeParse({ ...base, items: [{ recipeId: 'r1', quantity: 1.5 }] })
        .success,
    ).toBe(false);
  });

  it('rejects a negative selling price and a blank name', () => {
    expect(
      menuSchema.safeParse({ ...base, sellingPriceCents: -1 }).success,
    ).toBe(false);
    expect(menuSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });

  it('caps the item set at 100', () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      recipeId: `r${i}`,
      quantity: 1,
    }));
    expect(menuSchema.safeParse({ ...base, items }).success).toBe(false);
  });
});
