/**
 * Shared result shape for Server Actions: a discriminated union so client
 * components can show inline errors without throwing across the RPC boundary.
 *
 * The failure arm carries a stable `code` (never a localized string) — the
 * client maps it to a translated message via `useActionError()`
 * (lib/i18n/use-action-error.ts), honouring CLAUDE.md's "UI strings always via
 * next-intl". Add a new code here AND a matching `actionErrors.<code>` message.
 */
export type ActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'DUPLICATE_NAME'
  | 'ALREADY_IN_RECIPE'
  | 'INGREDIENT_IN_USE'
  | 'RECIPE_HAS_TRASHED_INGREDIENTS'
  | 'INGREDIENT_IN_TRASHED_RECIPE'
  | 'CATEGORY_IN_USE'
  | 'FORBIDDEN'
  | 'UNEXPECTED';

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: ActionErrorCode };
