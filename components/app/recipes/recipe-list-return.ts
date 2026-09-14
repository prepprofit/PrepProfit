/**
 * "Back to recipes" memory: the recipe list the user was browsing (its URL, search,
 * sort and scroll position), kept in sessionStorage so the recipe page can return to
 * exactly that list. Tab-scoped, best-effort — storage can be unavailable (private
 * mode, blocked site data), in which case callers fall back to the recipe's folder.
 */

const KEY = 'prepprofit:recipes:list-return';

export type RecipeListReturn = { href: string; query: string; sort: string; scrollTop: number };

export function rememberRecipeListReturn(value: RecipeListReturn): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — the back link falls back to the recipe's folder.
  }
}

export function readRecipeListReturn(): RecipeListReturn | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecipeListReturn>;
    if (typeof parsed.href !== 'string' || !parsed.href.startsWith('/recipes')) return null;
    return {
      href: parsed.href,
      query: typeof parsed.query === 'string' ? parsed.query : '',
      sort: typeof parsed.sort === 'string' ? parsed.sort : 'recent',
      scrollTop: typeof parsed.scrollTop === 'number' && Number.isFinite(parsed.scrollTop) ? parsed.scrollTop : 0,
    };
  } catch {
    return null;
  }
}

/** The app's scrolling region (the page body doesn't scroll — `main` does). */
export function scrollContainer(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector('main');
}
