import {
  INGREDIENT_SORT_COLUMNS,
  type IngredientSort,
} from '@/lib/ingredients/sort';

/**
 * The ingredient list's browsing context (search, sort, scroll position, the open
 * details popup), parked on the CURRENT history entry just before the user follows a
 * link out of the list (e.g. to a recipe). Browser Back returns to that exact entry, so
 * the state comes back with it — and only then: a fresh visit to /ingredients from the
 * sidebar is a new entry and always starts clean.
 *
 * Client-only and best-effort: every read/write is guarded, and a missing or malformed
 * value simply means "start fresh".
 */
export type IngredientListView = {
  query: string;
  sort: IngredientSort;
  scrollTop: number;
  detailsId: string | null;
};

const KEY = 'ingredientListView';

/** The scrollable app column (see AppShell's <main>). */
export function listScrollContainer(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('main');
}

export function saveIngredientListView(view: IngredientListView): void {
  try {
    window.history.replaceState({ ...(window.history.state ?? {}), [KEY]: view }, '');
  } catch {
    // History API unavailable (privacy modes, sandboxed frames) — nothing to preserve.
  }
}

export function readIngredientListView(): IngredientListView | null {
  try {
    const raw: unknown = window.history.state?.[KEY];
    if (typeof raw !== 'object' || raw === null) return null;
    const v = raw as Record<string, unknown>;
    const sort = v.sort as Record<string, unknown> | null | undefined;
    if (
      typeof v.query !== 'string' ||
      typeof v.scrollTop !== 'number' ||
      !Number.isFinite(v.scrollTop) ||
      (v.detailsId !== null && typeof v.detailsId !== 'string') ||
      typeof sort !== 'object' ||
      sort === null ||
      !(INGREDIENT_SORT_COLUMNS as readonly unknown[]).includes(sort.column) ||
      (sort.direction !== 'asc' && sort.direction !== 'desc') ||
      (sort.attentionFirst !== undefined && typeof sort.attentionFirst !== 'boolean')
    ) {
      return null;
    }
    return {
      query: v.query,
      sort: {
        column: sort.column as IngredientSort['column'],
        direction: sort.direction,
        ...(sort.attentionFirst === undefined ? {} : { attentionFirst: sort.attentionFirst }),
      },
      scrollTop: Math.max(0, v.scrollTop),
      detailsId: v.detailsId,
    };
  } catch {
    return null;
  }
}
