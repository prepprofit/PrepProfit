/**
 * "Back to recipes" memory for Kitchen Scale: the folder/search list the chef was
 * browsing (its URL + search query), kept in sessionStorage so the calculator's
 * "Back to recipes" action returns to exactly that list. Tab-scoped, best-effort —
 * storage can be unavailable (private mode, blocked site data), in which case the
 * caller falls back to the Kitchen Scale home.
 */

const KEY = 'prepprofit:kitchen-scale:list-return';

export type KitchenScaleListReturn = { href: string; query: string };

export function rememberKitchenScaleListReturn(value: KitchenScaleListReturn): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — the back link falls back to the Kitchen Scale home.
  }
}

export function readKitchenScaleListReturn(): KitchenScaleListReturn | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KitchenScaleListReturn>;
    if (typeof parsed.href !== 'string' || !parsed.href.startsWith('/kitchen-scale')) return null;
    return {
      href: parsed.href,
      query: typeof parsed.query === 'string' ? parsed.query : '',
    };
  } catch {
    return null;
  }
}
