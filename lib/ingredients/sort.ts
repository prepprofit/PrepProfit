import { isIncomplete, type IncompleteCandidate } from './incomplete';

/**
 * Column sorting for the Ingredients table: each heading sorts its own column, like a
 * spreadsheet. Pure so the ordering is tested without rendering the grid.
 *
 * Two tiers, always (decision D2): rows whose cost can't be trusted stay pinned on top;
 * the chosen column orders each tier. Empty values (no supplier) sink to the bottom in
 * BOTH directions — "nothing" is not a name. Ties fall back to the ingredient name.
 */

export const INGREDIENT_SORT_COLUMNS = ['name', 'dimension', 'price', 'supplier', 'updated'] as const;
export type IngredientSortColumn = (typeof INGREDIENT_SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';
export type IngredientSort = { column: IngredientSortColumn; direction: SortDirection };

export const DEFAULT_INGREDIENT_SORT: IngredientSort = { column: 'name', direction: 'asc' };

/** First click on a heading: newest first for Updated, otherwise A→Z / cheapest first. */
export function firstDirection(column: IngredientSortColumn): SortDirection {
  return column === 'updated' ? 'desc' : 'asc';
}

/** Clicking a heading: same column flips direction, a new column starts at its default. */
export function nextSort(current: IngredientSort, column: IngredientSortColumn): IngredientSort {
  if (current.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column, direction: firstDirection(column) };
}

export type SortableIngredient = IncompleteCandidate & {
  name: string;
  dimension: 'weight' | 'volume' | 'count';
  supplier: string | null;
  updatedAt: Date | string | null;
};

/** Type order: bought by the piece, by weight, by volume. */
const DIMENSION_ORDER: Record<SortableIngredient['dimension'], number> = { count: 0, weight: 1, volume: 2 };

function timeOf(value: Date | string | null): number {
  if (!value) return 0;
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? 0 : time;
}

const byName = (a: SortableIngredient, b: SortableIngredient) => a.name.localeCompare(b.name);

export function compareIngredients(
  a: SortableIngredient,
  b: SortableIngredient,
  sort: IngredientSort,
  canSeeCosts: boolean,
): number {
  const pinned = Number(isIncomplete(b, canSeeCosts)) - Number(isIncomplete(a, canSeeCosts));
  if (pinned !== 0) return pinned;

  const sign = sort.direction === 'asc' ? 1 : -1;
  switch (sort.column) {
    case 'name':
      return sign * byName(a, b);
    case 'dimension':
      return sign * (DIMENSION_ORDER[a.dimension] - DIMENSION_ORDER[b.dimension]) || byName(a, b);
    case 'price': {
      // A kitchen payload has no price at all; never sort on a missing key.
      if (!canSeeCosts) return byName(a, b);
      return sign * ((a.priceCents ?? 0) - (b.priceCents ?? 0)) || byName(a, b);
    }
    case 'supplier': {
      const empty = Number(!a.supplier) - Number(!b.supplier);
      if (empty !== 0) return empty;
      return sign * (a.supplier ?? '').localeCompare(b.supplier ?? '') || byName(a, b);
    }
    case 'updated':
      return sign * (timeOf(a.updatedAt) - timeOf(b.updatedAt)) || byName(a, b);
  }
}
